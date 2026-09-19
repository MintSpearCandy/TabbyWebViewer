/**
 * @hidden
 * Native-view plumbing for one web viewer pane.
 *
 * Tabby ships with webviewTag disabled, so a page is rendered by a
 * WebContentsView (obtained via @electron/remote) overlaid on the window.
 * The overlay floats above ALL DOM: bounds are synced from a host <div> in a
 * rAF loop, and the view is "docked" (parked off-screen) whenever DOM UI
 * must show above it (modals, drag gestures, our own error/empty pages).
 *
 * The bounds-sync / docking / hotkey-forwarding techniques are borrowed from
 * tabby-browser v0.2.0 (MIT, https://github.com/karolnowacki/tabby-browser).
 */
import { currentWebContents, currentWindow, getWebContentsViewClass, sessionFromPartition } from './electronApi'

export interface LoadErrorInfo {
    code: number
    description: string
    url: string
}

export interface ViewerViewHandlers {
    onDidNavigate (url: string): void
    onTitle (title: string): void
    onLoading (loading: boolean): void
    onLoadError (err: LoadErrorInfo): void
    onContextMenu (params: any): void
    onWindowOpen (url: string): void
    onFocusGained (): void
    /** Synchronous before-input-event hook; call event.preventDefault() when consumed. */
    onBeforeInput (event: { preventDefault (): void }, input: any): void
}

interface Bounds {
    x: number
    y: number
    width: number
    height: number
}

const ERR_ABORTED = -3

export class ViewerView {
    /** webContents ids of all live views — used to attribute app-level events. */
    private static readonly liveIds = new Set<number>()

    static isWebViewerWebContents (id: number): boolean {
        return ViewerView.liveIds.has(id)
    }

    readonly webContents: any
    private view: any
    private win: any
    private hostEl: HTMLElement
    private partition: string
    /**
     * Polled each frame: in a split layout the spanner overlaps a few px into
     * the pane, so the view insets from the host rect to stay off it. Done in
     * the bounds loop (not CSS) so it never goes stale with Angular's change
     * detection.
     */
    private isSplit: () => boolean
    private dockReasons = new Set<string>()
    private boundsKey = ''
    private zoomFactor = 1
    private frameCount = 0
    private rafId: number | null = null
    private visibleFlag = false
    private dead = false

    constructor (opts: { partition: string, ignoreCertErrors: boolean, hostEl: HTMLElement, isSplit?: () => boolean },
                 private handlers: ViewerViewHandlers) {
        this.partition = opts.partition
        this.hostEl = opts.hostEl
        this.isSplit = opts.isSplit ?? (() => false)

        // Session config must happen before the view loads: the verify proc
        // is sticky on a persistent session, so the non-ignoring branch
        // resets it explicitly (an earlier pane may have set one).
        // fromPartition(partition) returns the same main-process session the
        // view will use via the partition string in webPreferences.
        const ses = sessionFromPartition(opts.partition)
        if (opts.ignoreCertErrors) {
            ses.setCertificateVerifyProc((_request: any, callback: (result: number) => void) => callback(0))
        } else {
            ses.setCertificateVerifyProc(null)
        }

        const WebContentsView = getWebContentsViewClass()
        this.win = currentWindow()
        this.view = new WebContentsView({
            webPreferences: {
                partition: opts.partition,
                contextIsolation: true,
                sandbox: true,
            },
        })
        this.webContents = this.view.webContents
        ViewerView.liveIds.add(this.webContents.id)
        this.win.contentView.addChildView(this.view)
        this.zoomFactor = currentWebContents().getZoomFactor()
        this.wireEvents()
        this.setVisible(false)  // stays hidden until the tab's visibility$ fires
    }

    private wireEvents (): void {
        const wc = this.webContents
        wc.setWindowOpenHandler(({ url }: any) => {
            this.handlers.onWindowOpen(url)
            return { action: 'deny' }
        })
        wc.on('did-navigate', (_e: any, url: string) => this.handlers.onDidNavigate(url))
        wc.on('did-navigate-in-page', (_e: any, url: string) => this.handlers.onDidNavigate(url))
        wc.on('page-title-updated', (_e: any, title: string) => this.handlers.onTitle(title))
        wc.on('did-start-loading', () => this.handlers.onLoading(true))
        wc.on('did-stop-loading', () => this.handlers.onLoading(false))
        wc.on('did-fail-load', (_e: any, code: number, desc: string, url: string, isMain: boolean) => {
            if (isMain && code !== ERR_ABORTED) {
                this.handlers.onLoadError({ code, description: desc, url })
            }
        })
        wc.on('render-process-gone', (_e: any, details: any) => {
            this.handlers.onLoadError({
                code: -1,
                description: `Renderer process gone (${details?.reason ?? 'unknown'})`,
                url: wc.getURL(),
            })
        })
        wc.on('context-menu', (_e: any, params: any) => this.handlers.onContextMenu(params))
        wc.on('before-input-event', (event: any, input: any) => this.handlers.onBeforeInput(event, input))
        wc.on('focus', () => this.handlers.onFocusGained())
    }

    // ------------------------------------------------------------ bounds ---
    // The rAF loop reads the host div's rect and keeps the native view glued
    // to it. Coordinates are DIPs, so they are scaled by the host window's
    // zoom factor (cached, refreshed every 30 frames to avoid per-frame IPC).
    // A collapsed rect (< 2px, e.g. while a pane is maximized away) parks the
    // view, same as an explicit dock reason.
    private syncFrame (): void {
        if (this.dead || !this.visibleFlag) {
            this.rafId = null
            return
        }
        const rect = this.hostEl.getBoundingClientRect()
        const f = this.zoomFactor
        let b: Bounds
        if (this.dockReasons.size > 0 || rect.width < 2 || rect.height < 2) {
            b = { x: -(rect.width * f) - 1000, y: 0, width: rect.width * f, height: rect.height * f }
        } else {
            const inset = this.isSplit() ? 6 : 0
            b = {
                x: (rect.x + inset) * f,
                y: (rect.y + inset) * f,
                width: (rect.width - 2 * inset) * f,
                height: (rect.height - 2 * inset) * f,
            }
        }
        const key = `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)},${Math.round(b.height)}`
        if (key !== this.boundsKey) {
            this.boundsKey = key
            this.view.setBounds(b)
        }
        if (++this.frameCount >= 30) {
            this.frameCount = 0
            this.zoomFactor = currentWebContents().getZoomFactor()
        }
        this.rafId = requestAnimationFrame(() => this.syncFrame())
    }

    setVisible (v: boolean): void {
        if (this.dead || v === this.visibleFlag) {
            return
        }
        this.visibleFlag = v
        this.view.setVisible(v)
        if (v && this.rafId === null) {
            this.rafId = requestAnimationFrame(() => this.syncFrame())
        }
    }

    /**
     * Dock (reason = 'occlusion' | 'gesture' | 'state') parks the view
     * off-screen so DOM can show above it; undocking snaps it back.
     */
    setDocked (reason: string, on: boolean): void {
        const was = this.dockReasons.size > 0
        if (on) {
            this.dockReasons.add(reason)
        } else {
            this.dockReasons.delete(reason)
        }
        if (was !== (this.dockReasons.size > 0) && this.visibleFlag) {
            // Invalidate so the running rAF loop re-applies bounds next frame;
            // never call syncFrame() directly here — it would schedule a
            // second concurrent loop
            this.boundsKey = ''
            if (this.rafId === null) {
                this.rafId = requestAnimationFrame(() => this.syncFrame())
            }
        }
    }

    // ---------------------------------------------------------- actions ---
    navigate (url: string): void {
        this.webContents.loadURL(url).catch(() => { /* surfaced via did-fail-load */ })
    }

    back (): void {
        const nav = this.webContents.navigationHistory
        if (nav?.canGoBack()) {
            nav.goBack()
        }
    }

    forward (): void {
        const nav = this.webContents.navigationHistory
        if (nav?.canGoForward()) {
            nav.goForward()
        }
    }

    reload (): void {
        this.webContents.reload()
    }

    stop (): void {
        this.webContents.stop()
    }

    canGoBack (): boolean {
        const nav = this.webContents.navigationHistory
        return nav ? nav.canGoBack() : !!this.webContents.canGoBack?.()
    }

    canGoForward (): boolean {
        const nav = this.webContents.navigationHistory
        return nav ? nav.canGoForward() : !!this.webContents.canGoForward?.()
    }

    focus (): void {
        this.webContents.focus()
    }

    toggleDevTools (): void {
        if (this.webContents.isDevToolsOpened()) {
            this.webContents.closeDevTools()
        } else {
            this.webContents.openDevTools({ mode: 'detach' })
        }
    }

    currentUrl (): string {
        return this.webContents.getURL()
    }

    /** View offset within the window's content area (DIPs). */
    getBounds (): Bounds {
        return this.view.getBounds()
    }

    get webContentsId (): number {
        return this.webContents.id
    }

    async clearBrowsingData (): Promise<void> {
        const ses = sessionFromPartition(this.partition)
        await ses.clearStorageData({
            storages: ['cachestorage', 'cookies', 'filesystem', 'indexdb',
                       'localstorage', 'serviceworkers', 'shadercache', 'websql'],
        }).catch(() => {})
        await ses.clearCache().catch(() => {})
    }

    destroy (): void {
        if (this.dead) {
            return
        }
        this.dead = true
        ViewerView.liveIds.delete(this.webContents.id)
        if (this.rafId !== null) {
            cancelAnimationFrame(this.rafId)
        }
        try {
            this.win.contentView.removeChildView(this.view)
        } catch { /* window may already be closing */ }
        try {
            this.view.webContents.close()
        } catch { /* already gone */ }
        this.view = null
    }
}

/**
 * @hidden
 * Samples a 3x3 grid over the host rect every 33ms with
 * document.elementFromPoint; a visually-blocking non-descendant element on
 * top means the view is occluded (Tabby modal / menu).
 *
 * Invisible overlays (opacity 0 / visibility hidden / display none — e.g.
 * Tabby's split drop-detection layers) are ignored, and at least 2 sample
 * points must be covered so small floating elements (pane labels, tooltips)
 * don't trigger docking. Two consecutive occluded ticks are additionally
 * required so a one-frame artifact does not park the view.
 */
export class OcclusionWatcher {
    private timer: number | null = null
    private hits = 0
    private occluded = false

    constructor (private hostEl: HTMLElement,
                 private onChange: (occluded: boolean) => void) {}

    start (): void {
        if (this.timer !== null) {
            return
        }
        this.timer = window.setInterval(() => this.tick(), 33)
    }

    stop (): void {
        if (this.timer !== null) {
            window.clearInterval(this.timer)
            this.timer = null
        }
        this.hits = 0
        this.setOccluded(false)
    }

    private tick (): void {
        const rect = this.hostEl.getBoundingClientRect()
        if (rect.width < 4 || rect.height < 4) {
            return
        }
        // Inset edge samples: the split spanner overlaps a few px into the
        // pane and must not be sampled even without the CSS margin
        const inset = 4
        let coveredPoints = 0
        for (let i = 0; i <= 2 && coveredPoints < 2; i++) {
            for (let j = 0; j <= 2 && coveredPoints < 2; j++) {
                const x = rect.left + inset + ((rect.width - 2 * inset) * i) / 2
                const y = rect.top + inset + ((rect.height - 2 * inset) * j) / 2
                const el = document.elementFromPoint(x, y)
                if (el instanceof HTMLElement
                    && !el.closest('split-tab-spanner')
                    && !this.hostEl.contains(el)
                    && this.isVisuallyBlocking(el)) {
                    coveredPoints++
                }
            }
        }
        const hit = coveredPoints >= 2
        this.hits = hit ? this.hits + 1 : 0
        this.setOccluded(this.hits >= 2)
    }

    /**
     * Whether the element (or any ancestor up to the host) actually renders
     * pixels — transparent detection layers must not count as occluders.
     */
    private isVisuallyBlocking (el: HTMLElement): boolean {
        let node: HTMLElement | null = el
        while (node && node !== this.hostEl) {
            const cs = getComputedStyle(node)
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) {
                return false
            }
            node = node.parentElement
        }
        return true
    }

    private setOccluded (v: boolean): void {
        if (v !== this.occluded) {
            this.occluded = v
            this.onChange(v)
        }
    }

    destroy (): void {
        this.stop()
    }
}
