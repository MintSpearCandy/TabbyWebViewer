/**
 * @hidden
 * One web viewer pane. The DOM layer carries only the toolbar and docked-state
 * UI (empty page / load error); page content is the native WebContentsView
 * overlay owned by ViewerView.
 */
import {
    AfterViewInit, ChangeDetectorRef, Component, ElementRef, Injector, Input, NgZone, OnDestroy, OnInit, ViewChild,
} from '@angular/core'
import { AppService, BaseTabComponent, ConfigService, HotkeysService, RecoveryToken, SplitTabComponent } from 'tabby-core'
import { hostnameOf, makeWebViewerProfile, newPartitionId, normalizeUrl, partitionName, WebViewerProfile } from './api'
import { ensureClientCertificateSupport } from './clientCerts'
import { currentWebContents, currentWindow, focusedWebContentsId } from './electronApi'
import { SessionRecorder } from './recorder/recorder'
import { RecorderPanelComponent } from './recorder/recorderPanel.component'
import { RecorderTabComponent } from './recorder/recorderTab.component'
import { getRecorderRegistration, registerRecorder, unregisterRecorder } from './recorder/recorderRegistry'
import { LoadErrorInfo, OcclusionWatcher, ViewerView } from './viewHost'
import { popupPageContextMenu } from './pageContextMenu'
import { openInSystemBrowser } from './dataManagement'

@Component({
    selector: 'webviewer-tab',
    template: require('./webviewerTab.component.pug'),
    styles: [require('./webviewerTab.component.scss')],
})
export class WebViewerTabComponent extends BaseTabComponent implements OnInit, AfterViewInit, OnDestroy {
    static readonly RECOVERY_TYPE = 'webviewer-tab'
    /** HotkeysService dedupes by timeStamp; synthetic events need unique ones */
    private static syntheticTs = 0
    /**
     * Physical key-down state, SHARED across panes: code → time of its last
     * keydown. A keydown for a code that is already down (no keyup between)
     * is an auto-repeat — dropped here, because the engine has no repeat
     * dedupe of its own. Sharing matters: after a split hands the keyboard
     * to the new pane mid-chord, Chromium loses the repeat history and
     * delivers OS repeats to the new pane with isAutoRepeat=false, which
     * would otherwise cascade into one split per repeat tick.
     */
    private static downKeys = new Map<string, number>()
    /**
     * Keydowns any pane has forwarded to the hotkey engine, SHARED: a keyup
     * must reach the engine whichever pane it lands on. When a split moves
     * the keyboard mid-chord, the releasing keyups arrive at the NEW pane —
     * with per-pane pairing they would all be dropped, the engine's pressed
     * set would keep the whole chord, and re-pressing just the modifiers
     * re-matches the full combo (split-right again, no D pressed).
     */
    private static forwardedKeys = new Set<string>()

    @Input() profile: WebViewerProfile
    /** Focus the address bar on a URL-less pane — only for user-opened panes, not duplicates/splits. */
    @Input() autoFocusAddressBar = true
    @ViewChild('content') content: ElementRef
    @ViewChild('addressBarInput') addressBarInput: ElementRef
    /** In-pane recorder drawer (present only while open) — the view-focus
     *  hook below dismisses its multi-selection via this handle. */
    @ViewChild(RecorderPanelComponent) recorderPanel: RecorderPanelComponent

    addressBar = ''
    canGoBack = false
    canGoForward = false
    loading = false
    loadError: LoadErrorInfo | null = null
    hasUrl: boolean

    view: ViewerView | null = null

    /** Per-pane session recorder — created lazily on the first record click. */
    recorder: SessionRecorder | null = null
    recorderDrawerOpen = false

    private partitionId: string
    private lastVisible = false
    private claimingPaneFocus = false
    private occlusion: OcclusionWatcher | null = null
    /** Subscription to the parent split's focusChanged$ (re-wired on re-parent). */
    private paneFocusSub: { unsubscribe (): void } | null = null
    private paneFocusParent: SplitTabComponent | null = null
    /** Dock reason we last handed the keyboard to Tabby's DOM for. */
    private keyboardHandoff: string | null = null

    constructor (
        injector: Injector,
        private app: AppService,
        private configSvc: ConfigService,
        private hotkeys: HotkeysService,
        private zone: NgZone,
        private cdr: ChangeDetectorRef,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        // BaseTabComponent has no ngOnInit — no super call
        if (!this.profile.options.partitionId) {
            this.profile.options.partitionId = newPartitionId()
        }
        this.partitionId = this.profile.options.partitionId
        this.hasUrl = !!this.profile.options.url?.trim()
        this.addressBar = this.profile.options.url ?? ''
        this.setTitle(this.hasUrl ? hostnameOf(this.profile.options.url) : 'Web viewer')
        this.icon = this.profile.icon || 'fas fa-globe'

        this.subscribeUntilDestroyed(this.visibility$, v => this.onViewVisibility(v))
        // NOTE: no pane focused$/blurred$ subscriptions — SplitTabComponent
        // re-emits focused to EVERY pane on window/tab focus, and reacting to
        // those with programmatic keyboard moves between webContents creates
        // event feedback loops (focus storm). Instead, keyboard focus follows
        // the split's focusChanged$ (fired only when the focused PANE changes
        // — split, pane-nav, pane close): the newly focused pane takes the
        // keyboard (see wirePaneFocusHandover / claimKeyboardFocus).
        // Dock during gestures that would otherwise drag/tab under the overlay.
        // NOTE: rearrange-panes must NOT dock here — hiding the view kills
        // its input delivery, breaking any chord that begins with the
        // rearrange prefix (e.g. Ctrl+Shift+D = split-right)
        this.subscribeUntilDestroyed(this.app.tabDragActive$, drag => this.setDock('gesture', !!drag && this.lastVisible))

        // mTLS: when a site requests a client certificate and several are
        // available in the OS store, ask through Tabby's selector (choice is
        // remembered per host; single-certificate hosts are auto-selected)
        ensureClientCertificateSupport({
            choose: (host, certs) => this.app.showSelector(
                `Client certificate for ${host}`,
                certs.map((cert, index) => ({
                    name: cert.subjectName || `Certificate ${index + 1}`,
                    description: `Issuer: ${cert.issuerName || 'unknown'}`,
                    result: index,
                })),
            ).then(sel => (sel === undefined ? null : sel)),
        })
        this.addEventListenerUntilDestroyed(document.documentElement, 'mousedown', e => {
            if (this.lastVisible && (e.target as HTMLElement)?.closest?.('split-tab-spanner')) {
                this.setDock('gesture', true)
            }
        }, true)
        this.addEventListenerUntilDestroyed(document.documentElement, 'mouseup', () => this.setDock('gesture', false), true)
    }

    ngAfterViewInit (): void {
        this.zone.runOutsideAngular(() => this.createView())
    }

    private createView (): void {
        this.view = new ViewerView(
            {
                partition: partitionName(this.partitionId),
                ignoreCertErrors: !!this.profile.options.ignoreCertErrors,
                hostEl: this.content.nativeElement as HTMLElement,
                isSplit: () => this.isSplit,
            },
            {
                onDidNavigate: url => this.zone.run(() => this.onNavigated(url)),
                onTitle: title => this.zone.run(() => this.setTitle(title || 'Web viewer')),
                onLoading: b => this.zone.run(() => {
                    this.loading = b
                    this.cdr.detectChanges()
                }),
                onLoadError: err => this.zone.run(() => this.onLoadError(err)),
                onContextMenu: params => this.zone.run(() => this.onPageContextMenu(params)),
                onWindowOpen: url => this.zone.run(() => this.openUrlInNewTab(url)),
                onFocusGained: () => this.zone.run(() => this.anchorPaneFocus()),
                // NOTE: never dismiss the drawer selection here! This hook
                // fires for PROGRAMMATIC view.focus() too — e.g. the pane's
                // own claimKeyboardFocus() runs it whenever the user clicks
                // in the drawer (main DOM gains focus → split re-emits pane
                // focus), which wiped the selection the user just made.
                // Dismissal lives in onPageInteract (page click) instead.
                onBeforeInput: (event, input) => this.handleBeforeInput(event, input),
            },
        )
        if (this.hasUrl) {
            this.view.navigate(normalizeUrl(this.profile.options.url)!)
        } else {
            this.setDock('state', true)  // the empty-page hint is DOM
            if (this.autoFocusAddressBar) {
                setTimeout(() => {
                    this.addressBarInput?.nativeElement.focus()
                })
            }
        }
        this.occlusion = new OcclusionWatcher(
            this.content.nativeElement as HTMLElement,
            occluded => this.setDock('occlusion', occluded),
        )
        if (this.lastVisible) {
            this.view.setVisible(true)
            this.occlusion.start()
        }
    }

    // ------------------------------------------------------------ state ---
    /** Whether this pane lives in a multi-pane split layout. */
    get isSplit (): boolean {
        return this.parent instanceof SplitTabComponent && this.parent.getAllTabs().length > 1
    }

    private onNavigated (url: string): void {
        this.addressBar = url
        this.profile.options.url = url
        this.loadError = null
        this.hasUrl = true
        this.setDock('state', false)
        this.updateNavState()
        this.recorder?.addNavigation(url)
        this.recoveryStateChangedHint.next()  // persist the recovery token soon
        this.cdr.detectChanges()
    }

    private onLoadError (err: LoadErrorInfo): void {
        this.loadError = err
        this.setDock('state', true)  // the error page is DOM
        this.cdr.detectChanges()
    }

    private updateNavState (): void {
        this.canGoBack = this.view?.canGoBack() ?? false
        this.canGoForward = this.view?.canGoForward() ?? false
    }

    private onViewVisibility (v: boolean): void {
        this.lastVisible = v
        this.wirePaneFocusHandover()
        this.view?.setVisible(v)
        if (v) {
            this.occlusion?.start()
            this.markTopmostFocused()
        } else {
            this.occlusion?.stop()
            this.setDock('gesture', false)
            // The tab was switched away (keyboard or click on another tab
            // header — the pane may never see a mousedown or a view-focus
            // event for it): the drawer's multi-selection has lost "mouse
            // focus" and must not survive into the next visit
            this.recorderPanel?.clearSelection()
        }
    }

    private setDock (reason: string, on: boolean): void {
        this.view?.setDocked(reason, on)
        if (on) {
            if (reason !== 'gesture' && this.isFocusedPane()) {
                // Hand the keyboard back to Tabby's DOM while the view is parked.
                // Only the focused pane may do this: during a split, the OLD
                // pane's occlusion watcher false-positives on the layout churn
                // and must not steal the keyboard the NEW pane just claimed.
                currentWebContents().focus()
                this.keyboardHandoff = reason
            }
        } else if (reason === this.keyboardHandoff) {
            this.keyboardHandoff = null
            if (this.isFocusedPane()) {
                this.claimKeyboardFocus()  // the page can take over again
            }
        }
    }

    // ------------------------------------------------------- pane focus ---
    /**
     * Keeps keyboard focus glued to the split's focused pane. Wired lazily —
     * `parent` is only assigned once the pane is inserted into its split
     * (after the component is created), and re-wired if the pane is dragged
     * into another split.
     */
    private wirePaneFocusHandover (): void {
        const parent = this.parent instanceof SplitTabComponent ? this.parent : null
        if (parent === this.paneFocusParent) {
            return
        }
        this.paneFocusSub?.unsubscribe()
        this.paneFocusSub = null
        this.paneFocusParent = parent
        if (parent) {
            this.paneFocusSub = parent.focusChanged$.subscribe(tab => this.onPaneFocusChanged(tab))
        }
    }

    private onPaneFocusChanged (focused: BaseTabComponent): void {
        if (focused === this) {
            this.claimKeyboardFocus()
        }
        // NOTE: no selection dismissal in the else branch — the split
        // re-emits pane focus on every main-DOM focus change (clicking in
        // the drawer included), which would wipe the user's fresh selection
        // mid-gesture. Clicks into OTHER panes' pages dismiss their own
        // panels via onPageInteract; a stale selection here is cleared by
        // the next plain click / click-away.
    }

    /**
     * Take the keyboard for this pane: the page when it is showing, the
     * address bar when the pane is parked on its empty/error page. Skips
     * when the page already owns the keyboard, or when the user is typing
     * in this pane's own address bar.
     */
    private claimKeyboardFocus (): void {
        if (!this.lastVisible || !currentWindow().isFocused()) {
            return
        }
        if (focusedWebContentsId() === this.view?.webContentsId) {
            return  // our page already owns the keyboard
        }
        const ae = document.activeElement
        const host = this.hostEl()
        if (ae && ae !== document.body && host?.contains(ae)
            && focusedWebContentsId() === currentWebContents().id) {
            return  // the user is typing in this pane's address bar
        }
        if (ae && ae !== document.body && !host?.contains(ae) && ae.closest?.('webviewer-tab')) {
            (ae as HTMLElement).blur()  // stale address-bar focus left in another pane
        }
        if (this.view?.isDocked()) {
            currentWebContents().focus()  // typing must reach the address bar
            this.addressBarInput?.nativeElement.focus()
        } else {
            this.view?.focus()
        }
    }

    /** This pane's component host element, or null before the view exists. */
    private hostEl (): HTMLElement | null {
        return (this.content?.nativeElement as HTMLElement | undefined)?.closest?.('webviewer-tab') ?? null
    }

    private isFocusedPane (): boolean {
        const parent = this.parent
        return !(parent instanceof SplitTabComponent) || parent.getFocusedTab() === this
    }

    // --------------------------------------------------------- keyboard ---
    // Runs inside before-input-event (outside Angular): handled keys are
    // consumed here, remaining modifier/F-key combos are forwarded to Tabby's
    // hotkey engine (in their own zone.run where needed).
    private handleBeforeInput (event: { preventDefault (): void }, input: any): void {
        if (input.type !== 'keyDown' && input.type !== 'keyUp') {
            return
        }
        // Physical key-state gate (see WebViewerTabComponent.downKeys): a
        // keydown for a key that is already down is an auto-repeat, flagged
        // or not, and must reach neither the browser-key actions below nor
        // the hotkey engine — both would re-fire per repeat tick, and the
        // engine has no same-hotkey dedupe of its own. Keyups always clear
        // the key, wherever the paired keydown went.
        if (input.type === 'keyDown') {
            const now = performance.now()
            for (const [code, t] of WebViewerTabComponent.downKeys) {
                if (t < now - 2000) {
                    WebViewerTabComponent.downKeys.delete(code)  // mirror the engine's pressed-key TTL
                }
            }
            if (WebViewerTabComponent.downKeys.has(input.code)) {
                WebViewerTabComponent.downKeys.set(input.code, now)  // still held — keep it fresh
                return
            }
            if (input.isAutoRepeat) {
                // flagged repeat whose keydown went elsewhere (keyboard was
                // on the DOM) — the key is held; record it and drop the event
                WebViewerTabComponent.downKeys.set(input.code, now)
                return
            }
            WebViewerTabComponent.downKeys.set(input.code, now)
        } else {
            WebViewerTabComponent.downKeys.delete(input.code)
        }
        const key = (input.key || '').toLowerCase()
        if (input.type === 'keyDown') {
            if (key === 'f12' || (input.control && input.shift && key === 'i')) {
                event.preventDefault()
                this.view!.toggleDevTools()
                return
            }
            if (key === 'f5' || (input.control && key === 'r')) {
                event.preventDefault()
                this.view!.reload()
                return
            }
            // Alt+Left/Right = history nav, but ONLY without other modifiers —
            // Ctrl+Alt+Arrow is Tabby's pane navigation and must fall through
            if (input.alt && !input.control && !input.meta && !input.shift && key === 'arrowleft') {
                event.preventDefault()
                this.view!.back()
                return
            }
            if (input.alt && !input.control && !input.meta && !input.shift && key === 'arrowright') {
                event.preventDefault()
                this.view!.forward()
                return
            }
            // Redirect Tabby's zoom hotkeys (terminal font size) to PAGE zoom
            // while the page has focus — consumed here so Tabby's UI does not
            // zoom instead. Covers Ctrl(±Shift) with =/+/-/0 and numpad keys.
            if (input.control && !input.alt && !input.meta) {
                const code = input.code || ''
                if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') {
                    event.preventDefault()
                    this.view!.zoomPage(1)
                    return
                }
                if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') {
                    event.preventDefault()
                    this.view!.zoomPage(-1)
                    return
                }
                if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
                    event.preventDefault()
                    this.view!.zoomPage(0)
                    return
                }
            }
            if (input.control && !input.shift && key === 'l') {
                event.preventDefault()
                this.zone.run(() => this.focusAddressBar())
                return
            }
        }
        // Forward modifier combos / F-keys so Tabby hotkeys (pane nav, tab
        // switching, rearrange-panes, ...) keep working while the page has
        // focus. Plain characters are NOT forwarded — they belong to the page.
        // Modifier keydowns are ALWAYS forwarded (a later keyup of another
        // key carries no modifier flags and would otherwise leak a stuck
        // modifier into the engine); non-modifier events are forwarded only
        // to pair with a forwarded keydown — pairing state is pane-shared so
        // keyups survive the focus hop a split causes (see forwardedKeys).
        const isModifierKey = ['control', 'shift', 'alt', 'meta', 'altgraph', 'capslock'].includes(key)
        if (input.type === 'keyDown') {
            if (!(input.control || input.alt || input.meta) && !isModifierKey && !/^f\d{1,2}$/.test(key)) {
                return
            }
            WebViewerTabComponent.forwardedKeys.add(input.code)
        } else {
            if (!WebViewerTabComponent.forwardedKeys.delete(input.code)) {
                return
            }
        }
        // timeStamp must track the real clock: HotkeysService tells chords
        // (keys pressed together) from sequential presses by timestamp, and
        // expires stale modifiers by age. The tiny increment keeps events
        // unique (dedupe by timeStamp) without distorting the clock.
        const eventName = input.type === 'keyDown' ? 'keydown' : 'keyup'
        const synth = {
            timeStamp: performance.now() + (++WebViewerTabComponent.syntheticTs) * 1e-4,
            ctrlKey: !!input.control, altKey: !!input.alt,
            shiftKey: !!input.shift, metaKey: !!input.meta,
            key: input.key, code: input.code,
            // DOM-canonical lowercase, matching eventName — third-party hotkey
            // plugins (e.g. tabby-hotkey-guard) relabel any event whose `type`
            // disagrees, and Electron's 'keyDown'/'keyUp' casing would get the
            // event re-pushed under a type the engine never matches
            type: eventName,
            repeat: !!input.isAutoRepeat,
        } as unknown as KeyboardEvent
        this.hotkeys.pushKeyEvent(eventName, synth)
        if (input.type === 'keyDown' && this.hotkeys.matchActiveHotkey(true) !== null) {
            event.preventDefault()
        }
    }

    // --------------------------------------------------------- toolbar ---
    onToolbarClick (event: MouseEvent): void {
        if ((event.target as HTMLElement)?.closest?.('input')) {
            return  // keep focus in the address bar while typing
        }
        this.anchorPaneFocus()
    }

    /** Toolbar record button: creates the recorder + its UI, re-summons a hidden one, or toggles recording. */
    toggleRecording (): void {
        if (!this.view) {
            return
        }
        const layout = this.recorderLayout()
        if (!this.recorder) {
            const wcId = this.view.webContentsId
            this.zone.runOutsideAngular(() => {
                // Everything recorder-side runs outside the zone: CDP events
                // and the flush timer must not trigger app-wide change
                // detection (panels call their own detectChanges)
                const rec = new SessionRecorder(this.view!.webContents)
                rec.on({
                    onStateChange: () => this.zone.run(() => this.cdr.detectChanges()),
                })
                registerRecorder(wcId, rec, hostnameOf(this.view!.currentUrl() || this.profile.options.url || 'pane'))
                const reg = getRecorderRegistration(wcId)
                if (reg) {
                    reg.onTabClosed = () => this.onRecorderTabClosed()
                }
                rec.start()
                this.zone.run(() => {
                    this.recorder = rec
                    if (layout === 'tab') {
                        this.openRecorderTab()
                    } else {
                        this.recorderDrawerOpen = true
                    }
                    this.cdr.detectChanges()
                })
            })
            return
        }
        // Hidden-but-recording UI: the first click brings it BACK — stopping a
        // recording you cannot see (and losing events) would be a footgun
        if (layout === 'tab') {
            const reg = getRecorderRegistration(this.view.webContentsId)
            if (reg && !reg.tab) {
                this.openRecorderTab()
                return
            }
        } else if (!this.recorderDrawerOpen) {
            this.recorderDrawerOpen = true
            this.cdr.detectChanges()
            return
        }
        if (this.recorder.state === 'recording') {
            this.recorder.stop()
        } else {
            this.recorder.start()
        }
        this.cdr.detectChanges()
    }

    /** Configured recorder UI form (Settings → Web Viewer → Session recorder layout). */
    private recorderLayout (): 'bottom' | 'right' | 'tab' {
        const v = (this.configSvc.store.webviewer as { recorderLayout?: string } | undefined)?.recorderLayout
        return v === 'right' || v === 'tab' ? v : 'bottom'
    }

    /** Panel placement for the in-pane drawer forms. */
    get panelPlacement (): 'bottom' | 'right' {
        return this.recorderLayout() === 'right' ? 'right' : 'bottom'
    }

    /** Whether the pane body lays the drawer out beside (not below) the page. */
    get bodyHasRightDrawer (): boolean {
        return this.recorderDrawerOpen && !!this.recorder && this.recorderLayout() === 'right'
    }

    private openRecorderTab (): void {
        const id = this.view!.webContentsId
        const reg = getRecorderRegistration(id)
        if (reg?.tab) {
            reg.tab.focusSelf()
            return
        }
        this.app.openNewTab({ type: RecorderTabComponent, inputs: { targetId: id } })
    }

    /** Drawer closed: keep the recorder only while it is actually recording. */
    onRecorderPanelClosed (): void {
        this.recorderDrawerOpen = false
        if (this.recorder && this.recorder.state !== 'recording') {
            this.disposeRecorder()
        }
        this.cdr.detectChanges()
    }

    /**
     * Drawer resize drag in flight: park the native view (same gesture dock
     * as pane drags) — the handle drags toward the page, and once the pointer
     * crosses onto the view the OS routes the remaining mouse events into the
     * page's webContents, stalling the drag.
     */
    onDrawerResizeGesture (on: boolean): void {
        this.setDock('gesture', on && this.lastVisible)
    }

    /** Detached recorder tab closed: same keep-while-recording rule as the drawer. */
    private onRecorderTabClosed (): void {
        if (this.recorder && this.recorder.state !== 'recording' && !this.recorderDrawerOpen) {
            this.disposeRecorder()
            this.cdr.detectChanges()
        }
    }

    private disposeRecorder (): void {
        if (this.view && this.recorder) {
            unregisterRecorder(this.view.webContentsId)
        }
        this.recorder?.dispose()
        this.recorder = null
    }

    onAddressEnter (): void {
        const url = normalizeUrl(this.addressBar)
        if (url) {
            this.loadError = null
            this.view!.navigate(url)
        }
        this.view?.focus()
    }

    onAddressEscape (): void {
        this.addressBar = this.view?.currentUrl() ?? this.addressBar
        this.view?.focus()
    }

    goBack (): void {
        this.view?.back()
        this.view?.focus()
    }

    goForward (): void {
        this.view?.forward()
        this.view?.focus()
    }

    reload (): void {
        this.loadError = null
        this.view?.reload()
        this.view?.focus()
    }

    stopLoading (): void {
        this.view?.stop()
        this.view?.focus()
    }

    toggleDevTools (): void {
        this.view?.toggleDevTools()
    }

    async clearBrowsingData (): Promise<void> {
        await this.view?.clearBrowsingData()
        this.loadError = null
        this.view?.reload()
    }

    openInSystemBrowser (): void {
        openInSystemBrowser(this.view?.currentUrl() || this.profile.options.url)
    }

    // ------------------------------------------------------- integration ---
    private onPageContextMenu (params: any): void {
        if (!this.view) {
            return
        }
        popupPageContextMenu(this.view, params, {
            onOpenInNewTab: url => this.openUrlInNewTab(url),
            onClearBrowsingData: () => this.clearBrowsingData(),
        })
    }

    private openUrlInNewTab (url: string): void {
        const profile = makeWebViewerProfile({ url })
        this.app.openNewTab({ type: WebViewerTabComponent, inputs: { profile } })
    }

    /**
     * The native view swallows DOM clicks, so SplitTab's focus anchor goes
     * stale; re-anchor it whenever the page gains focus. Also mark the
     * TOP-LEVEL tab as focused — SplitTabComponent gates all of its hotkey
     * actions (split / pane-nav / rearrange) on its own hasFocus, which is
     * only set through DOM focus events the native view never triggers.
     * Direct property assignment: emitFocused() would fire focus events and
     * can create an event storm (renderer freeze).
     */
    private anchorPaneFocus (): void {
        if (this.parent instanceof SplitTabComponent && !this.claimingPaneFocus) {
            this.claimingPaneFocus = true
            try {
                this.parent.focus(this)
            } finally {
                this.claimingPaneFocus = false
            }
        }
        this.markTopmostFocused()
    }

    private markTopmostFocused (): void {
        const top = this.topmostParent as { hasFocus?: boolean } | null
        if (top && top !== this && top.hasFocus !== true) {
            top.hasFocus = true
        }
    }

    private focusAddressBar (): void {
        // Fallback scoped to THIS pane — a document-wide query would grab the
        // first pane's input in a split layout
        const el = this.addressBarInput?.nativeElement as HTMLInputElement
            ?? this.hostEl()?.querySelector<HTMLInputElement>('.webviewer-address')
        // The keyboard may sit on the native page view; hand it to the DOM so
        // typing actually reaches the input (element focus alone doesn't)
        currentWebContents().focus()
        el?.focus()
        el?.select()
    }

    // ---------------------------------------------------------- recovery ---
    async getRecoveryToken (): Promise<RecoveryToken | null> {
        const url = this.view?.currentUrl() || this.profile.options.url
        if (!url) {
            return null
        }
        return {
            type: WebViewerTabComponent.RECOVERY_TYPE,
            url,
            partitionId: this.partitionId,
            ignoreCertErrors: !!this.profile.options.ignoreCertErrors,
            // Both restart-restore and duplicate reuse the partition id (a
            // duplicated pane keeps its login state, like Chrome's "duplicate
            // tab"). To make duplicates isolated instead, set freshPartition
            // when options.includeState === false (the duplicate path) and
            // regenerate in WebViewerTabRecoveryProvider.recover().
        }
    }

    ngOnDestroy (): void {
        this.paneFocusSub?.unsubscribe()
        this.paneFocusSub = null
        this.paneFocusParent = null
        this.occlusion?.destroy()
        this.occlusion = null
        // Release the CDP session BEFORE the webContents goes away
        this.disposeRecorder()
        this.view?.destroy()
        this.view = null
        super.ngOnDestroy()
    }
}
