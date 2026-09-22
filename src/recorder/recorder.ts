/**
 * @hidden
 * CDP session recorder for one pane's webContents. A single debugger
 * session (webContents.debugger via @electron/remote) carries all three
 * streams:
 *   console — Runtime.consoleAPICalled / Runtime.exceptionThrown
 *   network — Network.* (+ Network.getResponseBody for textual bodies)
 *   events  — Runtime.addBinding + Page.addScriptToEvaluateOnNewDocument
 *             (see injectedSource.ts)
 *
 * Remote-mechanics rules (every remote call is a BLOCKING sendSync round
 * trip): the debugger proxy is cached once in the constructor; the command
 * budget at start/stop is fixed; getResponseBody is fetched only for
 * textual responses under 64KB, max 4 in flight, within a total body
 * budget. Event delivery is async and (like all ipcRenderer callbacks) NOT
 * zone-patched — onFlush/onStateChange arrive outside Angular, panels call
 * cdr.detectChanges() themselves. The flush timer is only ever created from
 * CDP-event paths (outside the zone) and self-cancels when idle, so it can
 * never pollute change detection for long.
 *
 * No static state on purpose: every pane owns its own recorder, and N panes
 * recording simultaneously are N independent debugger sessions.
 *
 * DevTools interplay (Electron allows one debugger per webContents):
 * devtools-opened → we proactively release the session (paused 'devtools');
 * devtools-closed → automatic re-attach, data preserved. External detaches
 * (target crash) pause without retry.
 */
import { INJECTED_SCRIPT_SOURCE } from './injectedSource'
import { ConsoleEntry, ConsoleLevel, DomEventEntry, NetworkEntry, RecorderState, SessionRecorderEvents } from './types'

const BINDING_NAME = '__tabbyWvReport'

const MAX_CONSOLE = 10000
const MAX_NETWORK = 5000
const MAX_EVENTS = 10000
const MAX_TEXT = 2000
const MAX_BODY_CHARS = 65536
const TOTAL_BODY_BUDGET = 32 * 1024 * 1024
const MAX_BODY_FETCHES = 4
const MAX_BODY_QUEUE = 32
const FLUSH_MS = 150

function isTextualMime (mime: string): boolean {
    return /text\/|json|javascript|xml|x-www-form-urlencoded|graphql|yaml|csv/i.test(mime)
}

function hostOf (url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return ''
    }
}

/** CDP headers arrive as {name: value} OR [{name, value}] — normalize both. */
function normalizeHeaders (h: any): Record<string, string> {
    const out: Record<string, string> = {}
    try {
        if (Array.isArray(h)) {
            for (const x of h) {
                if (x && x.name) {
                    out[x.name] = String(x.value ?? '')
                }
            }
        } else if (h && typeof h === 'object') {
            for (const k of Object.keys(h)) {
                out[k] = String(h[k])
            }
        }
    } catch { /* keep whatever parsed */ }
    return out
}

function decodePostDataBytes (entry: any): string {
    try {
        if (entry && typeof entry.bytes === 'string') {
            return atob(entry.bytes)
        }
    } catch { /* malformed base64 */ }
    return ''
}

/** Serialize one console APICalled argument (RemoteObject → short string). */
function renderArg (a: any): string {
    if (a === undefined || a === null) {
        return String(a)
    }
    if (typeof a.value === 'string') {
        return a.value
    }
    if (a.value !== undefined) {
        return String(a.value)
    }
    if (a.preview) {
        const props = (a.preview.properties ?? []).slice(0, 3)
            .map((x: any) => `${x.name}: ${x.value ?? ''}`)
        const head = a.preview.description ?? a.description ?? a.preview.type
        return props.length ? `${head} {${props.join(', ')}}` : String(head)
    }
    return String(a.description ?? a.type ?? '')
}

export class SessionRecorder {
    readonly consoleEntries: ConsoleEntry[] = []
    readonly networkEntries: NetworkEntry[] = []
    readonly eventEntries: DomEventEntry[] = []
    /** Entries dropped by the ring buffers (per stream) — surfaced in the panel. */
    droppedConsole = 0
    droppedNetwork = 0
    droppedEvents = 0
    state: RecorderState = 'paused'
    lastStateReason: string | null = null

    private wc: any
    private dbg: any
    /** User intent: true between start() and stop() (survives pause/resume). */
    private intentOn = false
    private attached = false
    private dead = false
    private scriptIdentifier: string | null = null
    private nextId = 1
    private dirty = false
    private flushTimer: number | null = null
    private listeners: SessionRecorderEvents[] = []
    /** requestId → live network entry (rebound on redirects). */
    private pending = new Map<string, NetworkEntry>()
    /** requestId → CDP monotonic timestamp of requestWillBeSent (duration math). */
    private requestTs = new Map<string, number>()
    private bodyBytes = 0
    private bodyFetches = 0
    private bodyQueue: NetworkEntry[] = []
    /** Entries whose bodies count against the budget (evicted oldest-first). */
    private bodyOwners: NetworkEntry[] = []

    private messageHandler: ((_e: any, method: string, params: any) => void) | null = null
    private detachHandler: ((_e: any, reason: string) => void) | null = null
    private devtoolsOpenedHandler: (() => void) | null = null
    private devtoolsClosedHandler: (() => void) | null = null

    constructor (webContents: any) {
        this.wc = webContents
        // ONE property read — every remote access is a blocking sendSync
        this.dbg = webContents.debugger

        this.messageHandler = (_e, method, params) => this.handleMessage(method, params)
        this.detachHandler = (_e, reason) => this.onForcedDetach(reason)
        this.devtoolsOpenedHandler = () => {
            // Deterministic pause: hand the single debugger slot to DevTools
            // before Chromium kicks us out
            if (this.intentOn && this.attached) {
                this.teardown('devtools')
            }
        }
        this.devtoolsClosedHandler = () => {
            if (this.intentOn && !this.attached && !this.dead) {
                this.attachAndEnable()
            }
        }
        try {
            this.wc.on('devtools-opened', this.devtoolsOpenedHandler)
            this.wc.on('devtools-closed', this.devtoolsClosedHandler)
        } catch { /* webContents may already be gone */ }
    }

    /** Subscribe to flush/state notifications; returns an unsubscribe fn. */
    on (events: SessionRecorderEvents): () => void {
        this.listeners.push(events)
        return () => {
            const i = this.listeners.indexOf(events)
            if (i >= 0) {
                this.listeners.splice(i, 1)
            }
        }
    }

    // ------------------------------------------------------------ control ---

    start (): void {
        if (this.dead || this.intentOn) {
            return
        }
        this.intentOn = true
        this.attachAndEnable()
    }

    stop (): void {
        if (this.dead || !this.intentOn) {
            return
        }
        this.intentOn = false
        this.teardown('stopped')
    }

    clear (): void {
        this.consoleEntries.length = 0
        this.networkEntries.length = 0
        this.eventEntries.length = 0
        this.droppedConsole = 0
        this.droppedNetwork = 0
        this.droppedEvents = 0
        this.pending.clear()
        this.requestTs.clear()
        this.bodyQueue.length = 0
        this.bodyOwners.length = 0
        this.bodyBytes = 0
        this.dirty = false
        for (const l of this.listeners) {
            l.onFlush?.()
        }
    }

    /** Navigation feed from the pane's own did-navigate handler. */
    addNavigation (url: string): void {
        this.pushEvent({
            id: this.nextId++,
            t: performance.now(),
            kind: 'navigate',
            selector: url.slice(0, 120),
            frameUrl: url,
        })
    }

    /** Full teardown — must run BEFORE the pane's view.destroy(). */
    dispose (): void {
        if (this.dead) {
            return
        }
        this.stop()
        this.dead = true
        try {
            this.wc.removeListener('devtools-opened', this.devtoolsOpenedHandler)
            this.wc.removeListener('devtools-closed', this.devtoolsClosedHandler)
        } catch { /* gone */ }
        if (this.flushTimer !== null) {
            window.clearInterval(this.flushTimer)
            this.flushTimer = null
        }
        this.listeners.length = 0
        this.wc = null
        this.dbg = null
    }

    // ---------------------------------------------------------- lifecycle ---

    private attachAndEnable (): void {
        if (this.dead || this.attached) {
            return
        }
        try {
            this.dbg.attach('1.3')
        } catch (e: any) {
            const msg = String((e && e.message) || e)
            this.emitState('paused', /another debugger/i.test(msg) ? 'devtools' : msg)
            return
        }
        this.attached = true
        this.dbg.on('detach', this.detachHandler)
        this.dbg.on('message', this.messageHandler)
        try {
            this.dbg.sendCommand('Runtime.enable')
            this.dbg.sendCommand('Network.enable', { maxPostDataSize: 65536 })
            this.dbg.sendCommand('Runtime.addBinding', { name: BINDING_NAME })
            this.dbg.sendCommand('Page.enable')
            Promise.resolve(this.dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: INJECTED_SCRIPT_SOURCE }))
                .then(r => { this.scriptIdentifier = r?.identifier ?? null }).catch(() => {})
            // Instrument the already-loaded page without waiting for a
            // navigation (the script above only covers future documents)
            Promise.resolve(this.dbg.sendCommand('Runtime.evaluate', { expression: INJECTED_SCRIPT_SOURCE })).catch(() => {})
        } catch (e: any) {
            // attached is already true — teardown() will detach what got enabled
            this.teardown(String((e && e.message) || e))
            return
        }
        this.emitState('recording', null)
    }

    /**
     * Detach in the required order: stop the event flood first, remove the
     * injected script + binding while commands are still valid, then detach.
     * Pending requests are finalized as failed. Emits paused(reason).
     */
    private teardown (reason: string): void {
        this.bodyQueue.length = 0
        this.sweepPending()
        if (!this.attached) {
            this.emitState('paused', reason)
            return
        }
        this.attached = false
        try {
            this.dbg.removeAllListeners('message')
            this.dbg.removeAllListeners('detach')
        } catch { /* target may be gone */ }
        const after = () => {
            try {
                this.dbg.detach()
            } catch { /* already detached / target gone */ }
            this.emitState('paused', reason)
        }
        const cleanups: Promise<any>[] = []
        if (this.scriptIdentifier !== null) {
            const id = this.scriptIdentifier
            this.scriptIdentifier = null
            cleanups.push(Promise.resolve(
                this.dbg.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: id })).catch(() => {}))
        }
        cleanups.push(Promise.resolve(
            this.dbg.sendCommand('Runtime.removeBinding', { name: BINDING_NAME })).catch(() => {}))
        Promise.all(cleanups).then(after, after)
    }

    private onForcedDetach (reason: string | undefined): void {
        if (!this.attached) {
            return
        }
        this.attached = false
        this.sweepPending()
        // No auto-retry: a crash/closed target must not loop; a DevTools
        // takeover is already covered by devtools-closed → attachAndEnable
        this.emitState('paused', `detached: ${reason ?? 'unknown'}`)
    }

    private sweepPending (): void {
        for (const e of this.pending.values()) {
            e.state = 'failed'
            e.errorText = e.errorText ?? 'aborted (recording stopped)'
        }
        this.pending.clear()
        this.requestTs.clear()
        this.markDirty()
    }

    private emitState (state: RecorderState, reason: string | null): void {
        this.state = state
        this.lastStateReason = reason
        for (const l of this.listeners) {
            l.onStateChange?.(state, reason)
        }
    }

    // ------------------------------------------------------------- events ---

    private handleMessage (method: string, params: any): void {
        if (!this.attached) {
            return
        }
        try {
            switch (method) {
                case 'Runtime.consoleAPICalled':
                    this.onConsole(params)
                    break
                case 'Runtime.exceptionThrown':
                    this.onException(params)
                    break
                case 'Network.requestWillBeSent':
                    this.onRequestWillBeSent(params)
                    break
                case 'Network.responseReceived':
                    this.onResponseReceived(params)
                    break
                case 'Network.loadingFinished':
                    this.onLoadingFinished(params)
                    break
                case 'Network.loadingFailed':
                    this.onLoadingFailed(params)
                    break
                case 'Runtime.bindingCalled':
                    this.onBindingCalled(params)
                    break
            }
        } catch { /* one malformed event must not break the session */ }
    }

    private onConsole (params: any): void {
        const type = String(params?.type ?? 'log')
        const level: ConsoleLevel = type === 'warning' ? 'warn'
            : (['log', 'info', 'error', 'debug'].includes(type) ? type as ConsoleLevel : 'log')
        const text = (params?.args ?? []).map(renderArg).join(' ').slice(0, MAX_TEXT)
        this.pushConsole({ id: this.nextId++, t: performance.now(), level, text })
    }

    private onException (params: any): void {
        const d = params?.exceptionDetails ?? {}
        const raw = String(d.exception?.description ?? d.text ?? 'Uncaught exception')
        const text = raw.split('\n').slice(0, 4).join('\n').slice(0, MAX_TEXT)
        this.pushConsole({ id: this.nextId++, t: performance.now(), level: 'error', text, uncaught: true })
    }

    private onRequestWillBeSent (params: any): void {
        const req = params?.request ?? {}
        const existing = this.pending.get(params.requestId)
        if (existing && !params.redirectResponse) {
            return  // duplicate fire for a known request — ignore
        }
        if (existing) {
            // Redirect hop: finalize the old entry with the redirect
            // response, record the re-send as a NEW entry (DevTools-style)
            const rr = params.redirectResponse
            existing.state = 'redirect'
            existing.status = rr.status ?? existing.status
            existing.statusText = String(rr.statusText ?? existing.statusText)
            existing.mimeType = String(rr.mimeType ?? existing.mimeType)
            existing.responseHeaders = normalizeHeaders(rr.headers)
            if (rr.encodedDataLength) {
                existing.encodedDataLength = rr.encodedDataLength
            }
            const ts = this.requestTs.get(params.requestId)
            if (ts !== undefined && typeof params.timestamp === 'number') {
                existing.durationMs = Math.max(0, Math.round((params.timestamp - ts) * 1000))
            }
        }
        const entry: NetworkEntry = {
            id: this.nextId++,
            requestId: params.requestId,
            t: performance.now(),
            wallTimeMs: Math.round((params.wallTime ?? params.timestamp ?? 0) * 1000),
            url: String(req.url ?? ''),
            domain: hostOf(String(req.url ?? '')),
            method: String(req.method ?? 'GET').toUpperCase(),
            resourceType: String(params.type ?? 'other').toLowerCase(),
            status: null,
            statusText: '',
            mimeType: '',
            requestHeaders: normalizeHeaders(req.headers),
            responseHeaders: {},
            encodedDataLength: 0,
            initiator: String(params.initiator?.type ?? 'other'),
            state: 'pending',
            durationMs: null,
            responseBodyBase64: false,
            hasBody: false,
            redirectedFromId: existing ? existing.id : undefined,
        }
        if (typeof req.postData === 'string' && req.postData.length > 0) {
            entry.postData = req.postData.slice(0, 65536)
        } else if (Array.isArray(req.postDataEntries)) {
            const joined = req.postDataEntries.map(decodePostDataBytes).filter(s => s !== '').join('')
            if (joined) {
                entry.postData = joined.slice(0, 65536)
            }
        }
        this.pending.set(params.requestId, entry)
        this.requestTs.set(params.requestId, params.timestamp ?? 0)
        this.pushNetwork(entry)
    }

    private onResponseReceived (params: any): void {
        const e = this.pending.get(params.requestId)
        if (!e) {
            return
        }
        const r = params.response ?? {}
        e.status = r.status ?? null
        e.statusText = String(r.statusText ?? '')
        e.mimeType = String(r.mimeType ?? '')
        e.responseHeaders = normalizeHeaders(r.headers)
        this.markDirty()
    }

    private onLoadingFinished (params: any): void {
        const e = this.pending.get(params.requestId)
        if (!e) {
            return
        }
        e.state = 'done'
        // loadingFinished's size is the authoritative one (responseReceived
        // often reports 0)
        e.encodedDataLength = params.encodedDataLength ?? e.encodedDataLength
        const ts = this.requestTs.get(params.requestId)
        if (ts !== undefined && typeof params.timestamp === 'number') {
            e.durationMs = Math.max(0, Math.round((params.timestamp - ts) * 1000))
        }
        this.pending.delete(params.requestId)
        this.requestTs.delete(params.requestId)
        this.maybeFetchBody(e)
        this.markDirty()
    }

    private onLoadingFailed (params: any): void {
        const e = this.pending.get(params.requestId)
        if (!e) {
            return
        }
        e.state = 'failed'
        e.errorText = String(params.errorText ?? '')
        e.canceled = !!params.canceled
        if (params.type) {
            e.resourceType = String(params.type).toLowerCase()
        }
        const ts = this.requestTs.get(params.requestId)
        if (ts !== undefined && typeof params.timestamp === 'number') {
            e.durationMs = Math.max(0, Math.round((params.timestamp - ts) * 1000))
        }
        this.pending.delete(params.requestId)
        this.requestTs.delete(params.requestId)
        this.markDirty()
    }

    private onBindingCalled (params: any): void {
        if (params?.name !== BINDING_NAME) {
            return
        }
        let evt: any
        try {
            evt = JSON.parse(params.payload)
        } catch {
            return
        }
        if (!evt || !['click', 'input', 'change', 'submit'].includes(evt.kind)) {
            return
        }
        if (evt.kind === 'click') {
            for (const l of this.listeners) {
                l.onPageInteract?.()
            }
        }
        this.pushEvent({
            id: this.nextId++,
            t: performance.now(),
            kind: evt.kind,
            selector: String(evt.selector ?? '').slice(0, 120),
            value: evt.value !== undefined ? String(evt.value).slice(0, 200) : undefined,
            snippet: evt.snippet !== undefined ? String(evt.snippet).slice(0, 80) : undefined,
            frameUrl: String(evt.frameUrl ?? '').slice(0, 300),
        })
    }

    // ---------------------------------------------------------- bodies ------

    private maybeFetchBody (e: NetworkEntry): void {
        if (this.dead || !this.attached || !e.requestId || e.state !== 'done') {
            return
        }
        if (!isTextualMime(e.mimeType)) {
            return
        }
        if (e.encodedDataLength > MAX_BODY_CHARS) {
            return
        }
        if (this.bodyBytes >= TOTAL_BODY_BUDGET) {
            return
        }
        if (this.bodyFetches >= MAX_BODY_FETCHES) {
            if (this.bodyQueue.length < MAX_BODY_QUEUE) {
                this.bodyQueue.push(e)
            }
            return
        }
        this.fetchBody(e)
    }

    private fetchBody (e: NetworkEntry): void {
        this.bodyFetches++
        Promise.resolve(this.dbg.sendCommand('Network.getResponseBody', { requestId: e.requestId }))
            .then((r: any) => {
                if (!this.attached || this.dead || !r || typeof r.body !== 'string' || r.body.length === 0) {
                    return
                }
                const body = r.body.length > MAX_BODY_CHARS ? r.body.slice(0, MAX_BODY_CHARS) : r.body
                // Enforce the total budget, evicting oldest bodies first
                while (this.bodyBytes + body.length > TOTAL_BODY_BUDGET && this.bodyOwners.length > 0) {
                    const victim = this.bodyOwners.shift()!
                    if (victim.responseBody) {
                        this.bodyBytes -= victim.responseBody.length
                    }
                    victim.responseBody = undefined
                    victim.hasBody = false
                }
                if (this.bodyBytes + body.length <= TOTAL_BODY_BUDGET) {
                    e.responseBody = body
                    e.responseBodyBase64 = !!r.base64Encoded
                    e.hasBody = true
                    this.bodyBytes += body.length
                    this.bodyOwners.push(e)
                    this.markDirty()
                }
            })
            .catch(() => { /* body evicted from the network cache — fine */ })
            .finally(() => {
                this.bodyFetches = Math.max(0, this.bodyFetches - 1)
                const next = this.bodyQueue.shift()
                if (next && this.attached && !this.dead) {
                    this.fetchBody(next)
                }
            })
    }

    // ------------------------------------------------------------- stores ---

    private pushConsole (e: ConsoleEntry): void {
        this.consoleEntries.push(e)
        if (this.consoleEntries.length > MAX_CONSOLE) {
            this.consoleEntries.splice(0, this.consoleEntries.length - MAX_CONSOLE)
            this.droppedConsole++
        }
        this.markDirty()
    }

    private pushNetwork (e: NetworkEntry): void {
        this.networkEntries.push(e)
        if (this.networkEntries.length > MAX_NETWORK) {
            this.networkEntries.splice(0, this.networkEntries.length - MAX_NETWORK)
            this.droppedNetwork++
        }
        this.markDirty()
    }

    private pushEvent (e: DomEventEntry): void {
        this.eventEntries.push(e)
        if (this.eventEntries.length > MAX_EVENTS) {
            this.eventEntries.splice(0, this.eventEntries.length - MAX_EVENTS)
            this.droppedEvents++
        }
        this.markDirty()
    }

    // -------------------------------------------------------------- flush ---

    /**
     * The timer is created only from CDP-event paths (outside the Angular
     * zone) and self-cancels on the first idle tick, so even if some path
     * ever creates it inside the zone it cannot pollute change detection
     * for more than one tick.
     */
    private markDirty (): void {
        this.dirty = true
        if (this.flushTimer === null && this.listeners.length > 0 && !this.dead) {
            this.flushTimer = window.setInterval(() => this.flushNow(), FLUSH_MS)
        }
    }

    private flushNow (): void {
        if (!this.dirty) {
            if (this.flushTimer !== null) {
                window.clearInterval(this.flushTimer)
                this.flushTimer = null
            }
            return
        }
        this.dirty = false
        for (const l of this.listeners) {
            l.onFlush?.()
        }
    }
}
