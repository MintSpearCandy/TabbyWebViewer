/**
 * @hidden
 * One web viewer pane. The DOM layer carries only the toolbar and docked-state
 * UI (empty page / load error); page content is the native WebContentsView
 * overlay owned by ViewerView.
 */
import {
    AfterViewInit, ChangeDetectorRef, Component, ElementRef, Injector, Input, NgZone, OnDestroy, OnInit, ViewChild,
} from '@angular/core'
import { AppService, BaseTabComponent, HotkeysService, RecoveryToken, SplitTabComponent } from 'tabby-core'
import { hostnameOf, makeWebViewerProfile, newPartitionId, normalizeUrl, partitionName, WebViewerProfile } from './api'
import { ensureClientCertificateSupport } from './clientCerts'
import { currentWebContents } from './electronApi'
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
    /** Non-modifier keydowns we forwarded — their keyups must follow (pairing). */
    private forwardedKeys = new Set<string>()

    @Input() profile: WebViewerProfile
    /** Focus the address bar on a URL-less pane — only for user-opened panes, not duplicates/splits. */
    @Input() autoFocusAddressBar = true
    @ViewChild('content') content: ElementRef
    @ViewChild('addressBarInput') addressBarInput: ElementRef

    addressBar = ''
    canGoBack = false
    canGoForward = false
    loading = false
    loadError: LoadErrorInfo | null = null
    hasUrl: boolean

    view: ViewerView | null = null

    private partitionId: string
    private lastVisible = false
    private claimingPaneFocus = false
    private occlusion: OcclusionWatcher | null = null

    constructor (
        injector: Injector,
        private app: AppService,
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
        // NOTE: no focused$/blurred$ subscriptions — programmatically taking
        // and handing back keyboard focus between webContents created event
        // feedback loops (focus storm). Focus interactions are limited to
        // direct, user-initiated ones (clicking the page / the address bar).
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
        this.view?.setVisible(v)
        if (v) {
            this.occlusion?.start()
            this.markTopmostFocused()
        } else {
            this.occlusion?.stop()
            this.setDock('gesture', false)
        }
    }

    private setDock (reason: string, on: boolean): void {
        this.view?.setDocked(reason, on)
        if (on && reason !== 'gesture') {
            // Hand the keyboard back to Tabby's DOM while the view is parked
            currentWebContents().focus()
        }
    }

    // --------------------------------------------------------- keyboard ---
    // Runs inside before-input-event (outside Angular): handled keys are
    // consumed here, remaining modifier/F-key combos are forwarded to Tabby's
    // hotkey engine (in their own zone.run where needed).
    private handleBeforeInput (event: { preventDefault (): void }, input: any): void {
        if (input.type !== 'keyDown' && input.type !== 'keyUp') {
            return
        }
        // Auto-repeat keydowns would re-trigger the hotkey engine on every
        // repeat (and, combined with focus-follows-split, cascade into
        // multiple splits from one held chord) — the engine has no
        // same-hotkey dedupe. Skip repeats entirely.
        if (input.isAutoRepeat) {
            return
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
        // Modifier keys themselves are ALWAYS forwarded (their keyup carries
        // no modifier flags and would otherwise leak a stuck modifier into
        // the engine); non-modifier keyups are forwarded only to pair a
        // previously-forwarded keydown.
        const isModifierKey = ['control', 'shift', 'alt', 'meta', 'altgraph', 'capslock'].includes(key)
        if (input.type === 'keyDown') {
            if (!(input.control || input.alt || input.meta) && !isModifierKey && !/^f\d{1,2}$/.test(key)) {
                return
            }
            this.forwardedKeys.add(input.code)
        } else {
            if (!this.forwardedKeys.delete(input.code)) {
                return
            }
        }
        // timeStamp must track the real clock: HotkeysService tells chords
        // (keys pressed together) from sequential presses by timestamp, and
        // expires stale modifiers by age. The tiny increment keeps events
        // unique (dedupe by timeStamp) without distorting the clock.
        const synth = {
            timeStamp: performance.now() + (++WebViewerTabComponent.syntheticTs) * 1e-4,
            ctrlKey: !!input.control, altKey: !!input.alt,
            shiftKey: !!input.shift, metaKey: !!input.meta,
            key: input.key, code: input.code, type: input.type,
            repeat: !!input.isAutoRepeat,
        } as unknown as KeyboardEvent
        this.hotkeys.pushKeyEvent(input.type === 'keyDown' ? 'keydown' : 'keyup', synth)
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
        const el = this.addressBarInput?.nativeElement as HTMLInputElement
            ?? document.querySelector<HTMLInputElement>('.webviewer-address')
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
        this.occlusion?.destroy()
        this.occlusion = null
        this.view?.destroy()
        this.view = null
        super.ngOnDestroy()
    }
}
