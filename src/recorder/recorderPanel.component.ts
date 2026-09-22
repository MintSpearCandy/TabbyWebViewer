/**
 * @hidden
 * The in-pane session recorder drawer (Console / Network / Events tabs).
 * Presentational only: it renders the recorder's arrays and re-renders on
 * the recorder's flush signal. Flush/state callbacks arrive OUTSIDE the
 * Angular zone — detectChanges() is called directly (component-scoped, safe
 * outside the zone).
 *
 * The drawer sits IN FLOW between the pane's toolbar and content area —
 * never absolutely positioned over the content — so the native view's
 * bounds loop simply shrinks the page and the occlusion watcher never sees
 * it. The drag handle is on the TOP edge: during a resize the pointer stays
 * over DOM territory (toolbar above / drawer below) and never crosses the
 * native view, so no gesture docking is needed.
 */
import { ChangeDetectorRef, Component, ElementRef, EventEmitter, HostBinding, HostListener, Input, OnDestroy, OnInit, Output } from '@angular/core'
import { SessionRecorder } from './recorder'
import { isStaticAsset, NetworkFilter, parseNetworkFilter } from './filters'
import { ConsoleEntry, DomEventEntry, NetworkEntry } from './types'
import { clipboardWriteText } from '../electronApi'

const VISIBLE_ROWS = 500

type TabName = 'console' | 'network' | 'events'

/** Where the drawer lives: below the page, beside it, or filling a detached tab. */
export type RecorderPlacement = 'bottom' | 'right' | 'full'

@Component({
    selector: 'webviewer-recorder-panel',
    template: require('./recorderPanel.component.pug'),
    styles: [require('./recorderPanel.component.scss')],
})
export class RecorderPanelComponent implements OnInit, OnDestroy {
    /**
     * Manual drawer sizes, remembered across opens (and shared between panes):
     * a re-summoned drawer must keep the height the user dragged to, not snap
     * back to the default.
     */
    private static drawerHeight = 240
    private static drawerWidth = 360

    @Input() recorder: SessionRecorder
    /** Drawer placement — decides resize axis and which edge carries the handle. */
    @Input() placement: RecorderPlacement = 'bottom'
    @Output() closed = new EventEmitter<void>()
    /**
     * Emits true while a resize drag is active: the handle drags TOWARD the
     * page, so the pointer crosses onto the native view — the pane must dock
     * (park) the view for the duration, or the OS routes the remaining mouse
     * events into the page and the drag stalls.
     */
    @Output() resizeGesture = new EventEmitter<boolean>()

    /**
     * The fixed size lives on the HOST element, applied THREE ways so no CSS
     * interaction can make the drawer size itself to its content (the v0.4.1
     * bug): an explicit height/width property, an inline `flex: 0 0 <size>px`
     * basis (flex-basis outranks the size property on the main axis), and
     * `overflow: hidden` in the stylesheet. All read the same shared static.
     */
    @HostBinding('style.height.px') get hostHeightPx (): number | null {
        return this.placement === 'bottom' ? RecorderPanelComponent.drawerHeight : null
    }

    @HostBinding('style.width.px') get hostWidthPx (): number | null {
        return this.placement === 'right' ? RecorderPanelComponent.drawerWidth : null
    }

    @HostBinding('style.flex') get hostFlex (): string {
        if (this.placement === 'bottom') {
            return `0 0 ${RecorderPanelComponent.drawerHeight}px`
        }
        if (this.placement === 'right') {
            return `0 0 ${RecorderPanelComponent.drawerWidth}px`
        }
        return '1 1 auto'
    }

    @HostBinding('class.wv-pl-right') get isRightPlacement (): boolean {
        return this.placement === 'right'
    }

    @HostBinding('class.wv-pl-full') get isFullPlacement (): boolean {
        return this.placement === 'full'
    }

    activeTab: TabName = 'console'
    networkFilterExpr = ''
    filterParsed: NetworkFilter = parseNetworkFilter('')
    hideStatics = true
    /** Row id whose inline detail block is expanded (console/events/network). */
    expandedId: number | null = null
    /** Selected row ids (current tab only; cleared on tab switch). */
    selectedIds = new Set<number>()
    private selectAnchor: number | null = null
    /** Row id where an in-flight drag-range selection started, or null. */
    private selectDragFrom: number | null = null
    private selectDragAdditive = false
    /**
     * Selection snapshot taken at sweep start. A sweep NEVER clears
     * anything while the button is held: mid-gesture the selection shows
     * snapshot ∪ swept range; the mouseup settles it (plain sweep replaces
     * with the range, ctrl sweep unions onto the snapshot).
     */
    private dragSnapshot: Set<number> | null = null
    /** Last row the sweep pointer entered (null until the sweep moves). */
    private selectDragTo: number | null = null
    private suppressNextClick = false
    /** Per-row open/closed overrides for a network row's detail SECTIONS. */
    private netSections = new Map<number, { [key: string]: boolean }>()
    /** DOM context menu (position:fixed — placed by the browser, no coordinate
     *  math, immune to DPI/zoom/multi-monitor mismatches). */
    ctxMenuOpen = false
    ctxMenuX = 0
    ctxMenuY = 0
    ctxMenuCount = 0

    consoleRows: ConsoleEntry[] = []
    networkRows: NetworkEntry[] = []
    eventRows: DomEventEntry[] = []
    consoleCount = 0
    networkCount = 0
    eventCount = 0
    consoleHidden = 0
    networkHidden = 0
    eventHidden = 0

    private unsub: (() => void) | null = null
    private dragging = false
    /** Pointer position (clientY for vertical, clientX for horizontal) at drag start. */
    private dragStartPos = 0
    /** Drawer size (height or width) at drag start. */
    private dragStartSize = 0

    constructor (
        private cdr: ChangeDetectorRef,
        private elRef: ElementRef,
    ) {}

    ngOnInit (): void {
        this.unsub = this.recorder.on({
            onFlush: () => {
                this.refresh()
                this.cdr.detectChanges()
            },
            onStateChange: () => {
                this.cdr.detectChanges()
            },
            // a click inside the native page: the user's focus left the
            // drawer (the host DOM never sees that click — see the comment
            // on clearSelection). Outside the zone; clearSelection's
            // component-scoped detectChanges is safe there.
            onPageInteract: () => this.clearSelection(),
        })
        this.refresh()
    }

    ngOnDestroy (): void {
        this.unsub?.()
        this.unsub = null
        this.endDrag()
    }

    // ------------------------------------------------------------ toolbar ---

    setTab (tab: TabName): void {
        this.activeTab = tab
        this.selectedIds.clear()
        this.selectAnchor = null
    }

    /** Toggle a row's inline detail block (console/events/network, DevTools-style). */
    toggleExpand (id: number): void {
        this.expandedId = this.expandedId === id ? null : id
    }

    // ---------------------------------------------------- row selection ---

    /**
     * Mouse-based multi-selection, file-manager style: plain click keeps its
     * expand/collapse meaning; ctrl+click toggles one row; a left sweep
     * (press on a row, move across others) range-selects — WITHOUT clearing
     * anything mid-gesture (snapshot ∪ range while held; plain settles to
     * the range on release, ctrl-held sweeps stay additive); shift+click
     * selects from the anchor. Right-click opens the copy menu.
     *
     * The selection is DISMISSED by: a plain click on a row, a mousedown
     * outside the drawer, a click INSIDE the page (recorder's onPageInteract
     * — the primary path: the view usually already holds the webContents
     * focus, so no focus event fires either), or the pane's view gaining
     * focus from elsewhere (onFocusGained hook).
     */
    onRowMouseDown (ev: MouseEvent, id: number): void {
        if (ev.button !== 0) {
            return
        }
        // A fresh press starts a new gesture: a leftover suppression from a
        // previous sweep must not eat this click. After a real sweep the
        // browser fires the trailing click on the mousedown/mouseup targets'
        // COMMON ANCESTOR (the list container), never on a row — so the
        // row-bound onRowClick never consumes it. Without this reset the
        // user's next plain click on a row is silently swallowed.
        this.suppressNextClick = false
        if (ev.ctrlKey || ev.metaKey) {
            if (this.selectedIds.has(id)) {
                this.selectedIds.delete(id)
            } else {
                this.selectedIds.add(id)
            }
            this.selectAnchor = id
            // ctrl+drag sweeps ADDITIVELY: the pre-existing selection stays
            this.selectDragFrom = id
            this.selectDragAdditive = true
            this.dragSnapshot = new Set(this.selectedIds)
            this.selectDragTo = null
            this.suppressNextClick = true
            this.cdr.detectChanges()
            return
        }
        if (ev.shiftKey && this.selectAnchor !== null) {
            this.selectRange(this.selectAnchor, id, false)
            this.suppressNextClick = true
            this.cdr.detectChanges()
            return
        }
        // plain press: only becomes a selection if the pointer sweeps onto
        // another row before release (onRowEnter); otherwise it stays a
        // click. Mid-gesture the old selection stays visible (union with
        // the swept range); the release settles to the range alone.
        this.selectDragFrom = id
        this.selectDragAdditive = false
        this.dragSnapshot = new Set(this.selectedIds)
        this.selectDragTo = null
    }

    onRowEnter (id: number): void {
        if (this.selectDragFrom === null || id === this.selectDragFrom) {
            return
        }
        this.suppressNextClick = true
        this.selectDragTo = id
        // mid-gesture: snapshot ∪ swept range — a sweep never ends (clears)
        // a selection while the button is held
        this.selectedIds = new Set(this.dragSnapshot ?? [])
        for (const rowId of this.rangeIds(this.selectDragFrom, id)) {
            this.selectedIds.add(rowId)
        }
        this.selectAnchor = this.selectDragFrom
        this.cdr.detectChanges()
    }

    onRowClick (ev: MouseEvent, id: number): void {
        if (ev.ctrlKey || ev.metaKey || ev.shiftKey || this.suppressNextClick) {
            this.suppressNextClick = false
            return
        }
        // a plain click on a single row dismisses any pending multi-selection
        // (the click keeps its expand/collapse meaning)
        this.clearSelection()
        this.toggleExpand(id)
    }

    /**
     * Dismiss the multi-selection: plain row click, click-away, a click in
     * the page (onPageInteract), or the pane's view gaining focus
     * (onFocusGained). A page click produces no DOM mousedown here — the
     * view is a separate webContents — and the view usually ALREADY holds
     * the webContents focus (DOM clicks don't shift it), so neither a
     * document listener nor a focus/blur event can catch it; the injected
     * script's click report is the only reliable signal.
     */
    clearSelection (): void {
        if (this.selectedIds.size === 0 && this.selectAnchor === null) {
            return
        }
        this.selectedIds.clear()
        this.selectAnchor = null
        this.cdr.detectChanges()
    }

    /**
     * Sweep release: settle the gesture. A plain sweep REPLACES the
     * selection with the swept range (the old selection stayed visible
     * mid-gesture and drops out here); a ctrl sweep has already unioned the
     * range onto the snapshot in onRowEnter — nothing more to do. A press
     * that never swept (selectDragTo null) was a click, not a sweep: leave
     * everything to onRowClick.
     */
    @HostListener('document:mouseup')
    onSelectDragEnd (): void {
        const from = this.selectDragFrom
        const to = this.selectDragTo
        this.selectDragFrom = null
        this.selectDragTo = null
        this.dragSnapshot = null
        if (from === null || to === null) {
            return
        }
        if (!this.selectDragAdditive) {
            this.selectedIds = this.rangeIds(from, to)
        }
        this.cdr.detectChanges()
    }

    /** Row ids between two rows (inclusive), in current list order. */
    private rangeIds (fromId: number, toId: number): Set<number> {
        const out = new Set<number>()
        const rows = this.currentRows()
        const i = rows.findIndex(r => r.id === fromId)
        const j = rows.findIndex(r => r.id === toId)
        if (i < 0 || j < 0) {
            return out
        }
        for (let k = Math.min(i, j); k <= Math.max(i, j); k++) {
            out.add(rows[k].id)
        }
        return out
    }

    private selectRange (fromId: number, toId: number, additive: boolean): void {
        const range = this.rangeIds(fromId, toId)
        if (!additive) {
            this.selectedIds.clear()
        }
        for (const rowId of range) {
            this.selectedIds.add(rowId)
        }
        this.selectAnchor = fromId
    }

    onRowContextMenu (ev: MouseEvent, id: number): void {
        ev.preventDefault()
        ev.stopPropagation()
        // right-clicking an unselected row moves the selection to it
        if (!this.selectedIds.has(id)) {
            this.selectedIds.clear()
            this.selectedIds.add(id)
            this.selectAnchor = id
        }
        this.ctxMenuCount = this.selectedIds.size
        // position:fixed takes viewport CSS px directly — the browser performs
        // the alignment; clamp so the menu never leaves the window
        this.ctxMenuX = Math.min(ev.clientX, window.innerWidth - 190)
        this.ctxMenuY = Math.min(ev.clientY, window.innerHeight - 90)
        this.ctxMenuOpen = true
        this.cdr.detectChanges()
    }

    /** Menu items call these so the menu always closes after the action. */
    copyFromCtxMenu (): void {
        this.copySelection()
        this.closeCtxMenu()
    }

    selectAllFromCtxMenu (): void {
        this.selectAll()
        this.closeCtxMenu()
    }

    closeCtxMenu (): void {
        if (this.ctxMenuOpen) {
            this.ctxMenuOpen = false
            this.cdr.detectChanges()
        }
    }

    @HostListener('document:mousedown', ['$event'])
    onDocMousedown (ev: MouseEvent): void {
        if (this.ctxMenuOpen && !(ev.target as HTMLElement)?.closest?.('.wv-ctx-menu')) {
            this.closeCtxMenu()
        }
        // click-away dismissal: a press anywhere outside this drawer (other
        // panes, toolbar, terminals) deselects. A click on the NATIVE page
        // view never reaches this DOM at all — the host pane signals that
        // case via clearSelection() when the view gains focus.
        if (!this.elRef.nativeElement.contains(ev.target as Node)) {
            this.clearSelection()
        }
    }

    @HostListener('document:keydown.escape')
    onEsc (): void {
        this.closeCtxMenu()
    }

    selectAll (): void {
        this.selectedIds = new Set(this.currentRows().map(r => r.id))
        this.cdr.detectChanges()
    }

    /** Ctrl+C — copies the selection when the focus is not in an input. */
    @HostListener('document:keydown', ['$event'])
    onKeydown (ev: KeyboardEvent): void {
        if (!ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) {
            return
        }
        if (ev.key !== 'c' && ev.key !== 'C') {
            return
        }
        const t = ev.target as HTMLElement | null
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
            return
        }
        if (this.selectedIds.size === 0) {
            return
        }
        ev.preventDefault()
        ev.stopPropagation()
        this.copySelection()
    }

    copySelection (): void {
        const text = this.buildCopyText()
        if (text) {
            clipboardWriteText(text)
        }
    }

    /**
     * Per the spec: collapsed rows contribute their one-line summary,
     * expanded rows contribute their full detail — joined by newlines.
     */
    private buildCopyText (): string {
        const parts: string[] = []
        for (const row of this.currentRows()) {
            if (!this.selectedIds.has(row.id)) {
                continue
            }
            parts.push(this.expandedId === row.id ? this.rowDetail(row) : this.rowSummary(row))
        }
        return parts.join('\n')
    }

    private currentRows (): Array<ConsoleEntry | NetworkEntry | DomEventEntry> {
        if (this.activeTab === 'console') {
            return this.consoleRows
        }
        if (this.activeTab === 'network') {
            return this.networkRows
        }
        return this.eventRows
    }

    private rowSummary (row: ConsoleEntry | NetworkEntry | DomEventEntry): string {
        if ('level' in row) {
            return `[${row.level.toUpperCase()}] ${row.text}`
        }
        if ('method' in row) {
            return `${row.method} ${row.status === null ? '…' : row.status} ${row.url}`
                + (row.errorText ? ` (${row.errorText})` : '')
        }
        let s = `${row.kind} ${row.selector}`
        if (row.value !== undefined) {
            s += ` = ${row.value}`
        }
        if (row.snippet) {
            s += ` "${row.snippet}"`
        }
        return s
    }

    private rowDetail (row: ConsoleEntry | NetworkEntry | DomEventEntry): string {
        if ('level' in row) {
            return `[#${row.id} ${row.level} t=${this.fmtMs(row.t)}ms]\n${row.text}`
        }
        if ('method' in row) {
            const lines = [
                `#${row.id} ${row.method} ${row.url}`,
                `Status: ${row.status === null ? 'pending' : `${row.status} ${row.statusText}`}`,
                `Type: ${row.resourceType} · MIME: ${row.mimeType || '—'} · Size: ${this.fmtSize(row.encodedDataLength)}`
                    + ` · Duration: ${row.durationMs === null ? '—' : row.durationMs + 'ms'} · Initiator: ${row.initiator}`,
            ]
            if (row.redirectedFromId) {
                lines.push(`Redirect of: #${row.redirectedFromId}`)
            }
            if (row.errorText) {
                lines.push(`Error: ${row.errorText}${row.canceled ? ' (canceled)' : ''}`)
            }
            lines.push('Request headers:')
            lines.push(...this.headerLines(row.requestHeaders))
            if (row.postData) {
                lines.push('Request body:')
                lines.push(row.postData)
            }
            lines.push('Response headers:')
            lines.push(...this.headerLines(row.responseHeaders))
            if (row.responseBody) {
                lines.push('Response body:')
                lines.push(row.responseBody)
            }
            return lines.join('\n')
        }
        const lines = [`#${row.id} ${row.kind} t=${this.fmtMs(row.t)}ms`, `selector: ${row.selector}`]
        if (row.value !== undefined) {
            lines.push(`value: ${row.value}`)
        }
        if (row.snippet) {
            lines.push(`text: ${row.snippet}`)
        }
        lines.push(`frame: ${row.frameUrl}`)
        return lines.join('\n')
    }

    private headerLines (h: Record<string, string>): string[] {
        const entries = this.headerEntries(h)
        return entries.length ? entries.map(([k, v]) => `${k}: ${v}`) : ['(none)']
    }

    /** Toggle one collapsible SECTION inside an expanded network row. */
    toggleNetSection (rowId: number, key: string, defaultOpen: boolean): void {
        const st = this.netSections.get(rowId) ?? {}
        st[key] = !(st[key] ?? defaultOpen)
        this.netSections.set(rowId, st)
    }

    netSectionOpen (rowId: number, key: string, defaultOpen: boolean): boolean {
        const st = this.netSections.get(rowId)
        return st && key in st ? !!st[key] : defaultOpen
    }

    onFilterChange (): void {
        this.filterParsed = parseNetworkFilter(this.networkFilterExpr)
        this.refresh()
    }

    clearAll (): void {
        this.recorder.clear()
        this.expandedId = null
        this.selectedIds.clear()
        this.selectAnchor = null
        this.netSections.clear()
        this.refresh()
    }

    stateBanner (): string {
        const reason = this.recorder.lastStateReason
        if (reason === 'devtools') {
            return '已暂停 — DevTools 打开中，关闭 DevTools 后自动恢复'
        }
        if (reason === 'stopped') {
            return '已停止'
        }
        if (reason && reason.startsWith('detached:')) {
            return `会话被断开（${reason.slice('detached:'.length)}），请重新开始录制`
        }
        return `已暂停${reason ? ` — ${reason}` : ''}`
    }

    exportSession (): void {
        const rec = this.recorder
        const payload = {
            tool: 'tabby-webviewer session recorder',
            exportedAt: new Date().toISOString(),
            dropped: {
                console: rec.droppedConsole,
                network: rec.droppedNetwork,
                events: rec.droppedEvents,
            },
            console: rec.consoleEntries,
            network: rec.networkEntries,
            events: rec.eventEntries,
        }
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        const pad = (n: number) => String(n).padStart(2, '0')
        const now = new Date()
        a.download = `webviewer-session-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
            + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    }

    // ------------------------------------------------------------- resize ---

    /** Vertical (bottom drawer, top-edge handle) vs horizontal (right drawer, left-edge handle). */
    private get verticalResize (): boolean {
        return this.placement !== 'right'
    }

    onResizeStart (ev: PointerEvent): void {
        if (this.placement === 'full') {
            return
        }
        if (this.dragging) {
            // A fresh pointerdown while "dragging" means the previous pointerup
            // was lost (released off-window) — restart cleanly, never ignore
            this.endDrag()
        }
        this.dragging = true
        this.dragStartPos = this.verticalResize ? ev.clientY : ev.clientX
        this.dragStartSize = this.verticalResize
            ? RecorderPanelComponent.drawerHeight : RecorderPanelComponent.drawerWidth
        try {
            (ev.target as HTMLElement).setPointerCapture?.(ev.pointerId)
        } catch { /* capture is a hardening extra, window listeners are primary */ }
        window.addEventListener('pointermove', this.resizeMove)
        window.addEventListener('pointerup', this.resizeEnd)
        window.addEventListener('pointercancel', this.resizeEnd)
        this.resizeGesture.emit(true)
    }

    private resizeMove = (ev: PointerEvent) => {
        if (!this.dragging) {
            return
        }
        if (ev.buttons === 0) {
            // pointerup was lost (e.g. released outside the window) — self-heal
            this.endDrag()
            return
        }
        const host = this.elRef.nativeElement as HTMLElement
        // Clamp against the PANE root, not the host: the host's own size is
        // the drawer's size, which would make the clamp self-referential
        const paneRoot = host.closest?.('.webviewer-root') as HTMLElement | null
        // Both handles sit on the drawer's pane-facing edge, so dragging
        // TOWARD the pane (up / left) grows it — same sign form for both axes
        const cur = this.verticalResize ? ev.clientY : ev.clientX
        const size = this.dragStartSize - (cur - this.dragStartPos)
        if (this.verticalResize) {
            // never let the drawer starve the page: keep ~90px of content area
            // (paneRoot also contains the toolbar, hence the extra headroom)
            const h = paneRoot ? Math.max(120, Math.min(size, paneRoot.clientHeight - 140)) : Math.max(120, size)
            // Update the shared static immediately: the HostBindings re-apply
            // it on any change detection, so a stale value would fight the
            // direct style writes below
            RecorderPanelComponent.drawerHeight = h
            host.style.height = `${h}px`      // bypass Angular for 60fps
            host.style.flex = `0 0 ${h}px`
        } else {
            const w = paneRoot ? Math.max(200, Math.min(size, paneRoot.clientWidth - 140)) : Math.max(200, size)
            RecorderPanelComponent.drawerWidth = w
            host.style.width = `${w}px`
            host.style.flex = `0 0 ${w}px`
        }
    }

    private resizeEnd = () => this.endDrag()

    private endDrag (): void {
        if (!this.dragging) {
            return
        }
        this.dragging = false
        window.removeEventListener('pointermove', this.resizeMove)
        window.removeEventListener('pointerup', this.resizeEnd)
        window.removeEventListener('pointercancel', this.resizeEnd)
        this.resizeGesture.emit(false)
    }

    // ------------------------------------------------------------ formats ---

    fmtT (t: number, t0: number | undefined): string {
        if (t0 === undefined || t0 === null) {
            return ''
        }
        return `+${((t - t0) / 1000).toFixed(1)}s`
    }

    /** Raw performance.now() ms for the expanded row's meta line. */
    fmtMs (t: number): string {
        return String(Math.round(t))
    }

    fmtSize (n: number): string {
        if (!n || n <= 0) {
            return '—'
        }
        if (n < 1024) {
            return `${n} B`
        }
        if (n < 1024 * 1024) {
            return `${(n / 1024).toFixed(1)} KB`
        }
        return `${(n / 1024 / 1024).toFixed(1)} MB`
    }

    fmtUrl (e: NetworkEntry): string {
        let path = e.url
        try {
            const u = new URL(e.url)
            path = u.pathname + u.search
        } catch { /* non-URL scheme — show raw */ }
        const s = e.domain + path
        return s.length > 90 ? s.slice(0, 90) + '…' : s
    }

    /** Header object → entries for the collapsible header sections. */
    headerEntries (h: Record<string, string>): Array<[string, string]> {
        return Object.keys(h).map(k => [k, h[k]] as [string, string])
    }

    netStatusClass (e: NetworkEntry): string {
        if (e.state === 'failed' || (e.status !== null && e.status >= 400)) {
            return 'st-err'
        }
        if (e.status === null) {
            return 'st-pending'
        }
        if (e.status >= 300) {
            return 'st-redir'
        }
        if (e.status >= 200) {
            return 'st-ok'
        }
        return ''
    }

    /** Row status cell: pending dots, failed cross, or the numeric status. */
    statusText (e: NetworkEntry): string {
        if (e.status === null) {
            return e.state === 'failed' ? '✗' : '…'
        }
        return String(e.status)
    }

    kindIcon (kind: string): string {
        switch (kind) {
            case 'click': return 'fa-hand-pointer'
            case 'input': return 'fa-keyboard'
            case 'change': return 'fa-i-cursor'
            case 'submit': return 'fa-paper-plane'
            default: return 'fa-location-arrow'
        }
    }

    frameHost (e: DomEventEntry): string {
        try {
            return new URL(e.frameUrl).hostname
        } catch {
            return e.frameUrl
        }
    }

    /** Whether the event came from a frame whose origin differs from the last top navigation. */
    isForeignFrame (e: DomEventEntry): boolean {
        if (e.kind === 'navigate' || !e.frameUrl) {
            return false
        }
        const entries = this.recorder.eventEntries
        for (let i = entries.length - 1; i >= 0; i--) {
            if (entries[i].kind === 'navigate') {
                try {
                    return new URL(e.frameUrl).hostname !== new URL(entries[i].frameUrl).hostname
                } catch {
                    return false
                }
            }
        }
        return false
    }

    trackById (_index: number, item: ConsoleEntry | NetworkEntry | DomEventEntry): number {
        return item.id
    }

    // ------------------------------------------------------------- render ---

    private passesFilter (e: NetworkEntry): boolean {
        return (!this.hideStatics || !isStaticAsset(e)) && this.filterParsed.test(e)
    }

    /** Recomputes visible rows + counts; called on flush and on control changes. */
    refresh (): void {
        const rec = this.recorder
        const cap = (rows: number) => rows > VISIBLE_ROWS ? VISIBLE_ROWS : rows

        this.consoleCount = rec.consoleEntries.length
        this.eventCount = rec.eventEntries.length
        const filteredNet = rec.networkEntries.filter(e => this.passesFilter(e))
        this.networkCount = filteredNet.length

        this.consoleRows = rec.consoleEntries.slice(rec.consoleEntries.length - cap(this.consoleCount))
        this.consoleHidden = this.consoleCount - this.consoleRows.length
        this.networkRows = filteredNet.slice(filteredNet.length - cap(this.networkCount))
        this.networkHidden = this.networkCount - this.networkRows.length
        this.eventRows = rec.eventEntries.slice(rec.eventEntries.length - cap(this.eventCount))
        this.eventHidden = this.eventCount - this.eventRows.length
    }
}
