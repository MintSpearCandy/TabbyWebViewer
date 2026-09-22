/**
 * @hidden
 * Data model for the per-pane session recorder. Pure types only — this file
 * must stay import-free so filters.ts compiles standalone for `npm test`
 * (the test script tsc-invokes a hand-picked file list; see package.json).
 */

export type RecorderState = 'recording' | 'paused'

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
    id: number
    /** performance.now() ms — monotonic, comparable with network/event rows. */
    t: number
    level: ConsoleLevel
    /** Serialized message text, length-capped by the recorder. */
    text: string
    /** Set when this came from Runtime.exceptionThrown (uncaught error). */
    uncaught?: boolean
}

export interface NetworkEntry {
    id: number
    /** CDP requestId — several CDP events mutate the same entry in place. */
    requestId: string
    /** performance.now() ms at requestWillBeSent. */
    t: number
    /** Wall-clock epoch ms (CDP wallTime) — used for export readability. */
    wallTimeMs: number
    url: string
    domain: string
    method: string
    /** CDP ResourceType, normalized to lowercase by the recorder. */
    resourceType: string
    /** null while the request is pending. */
    status: number | null
    statusText: string
    mimeType: string
    requestHeaders: Record<string, string>
    responseHeaders: Record<string, string>
    /** Request body when CDP provided one (capped at 64KB). */
    postData?: string
    /** Authoritative wire size from loadingFinished (responseReceived's is often 0). */
    encodedDataLength: number
    initiator: string
    state: 'pending' | 'done' | 'failed' | 'redirect'
    errorText?: string
    canceled?: boolean
    /** request → finish delta in ms. */
    durationMs: number | null
    responseBody?: string
    responseBodyBase64: boolean
    /** Whether a response body was captured (vs. skipped: binary / too large). */
    hasBody: boolean
    redirectedFromId?: number
}

export interface DomEventEntry {
    id: number
    t: number
    kind: 'click' | 'input' | 'change' | 'submit' | 'navigate'
    /** cssPath from the injected script, or the URL for kind='navigate'. */
    selector: string
    value?: string
    snippet?: string
    frameUrl: string
}

export interface SessionRecorderEvents {
    /**
     * ~150ms cadence while dirty, fired OUTSIDE the Angular zone — panels
     * call cdr.detectChanges() directly. Network entries mutate in place,
     * so there is no payload: read the recorder's arrays.
     */
    onFlush? (): void
    onStateChange? (state: RecorderState, reason: string | null): void
    /**
     * The user interacted with the PAGE itself (a click inside the native
     * view, reported by the injected script). Also fired OUTSIDE the zone.
     * Panels use it to dismiss their multi-selection: the view is a separate
     * webContents, so the host DOM sees neither a mousedown nor a focus
     * shift (the view usually ALREADY holds the webContents focus, making
     * the pane's onFocusGained hook a no-op) — this binding is the only
     * reliable signal that "mouse focus" left the drawer.
     */
    onPageInteract? (): void
}
