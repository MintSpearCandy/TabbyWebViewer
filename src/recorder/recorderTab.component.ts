/**
 * @hidden
 * Detached recorder layout: a dedicated Tabby tab rendering the same recorder
 * panel (placement 'full') against a pane's session, looked up in the
 * recorder registry. Split it beside its web viewer pane for a
 * DevTools-detach-like side-by-side view; the pane's record button re-focuses
 * this tab instead of toggling recording off.
 */
import { Component, Injector, Input, OnDestroy, OnInit } from '@angular/core'
import { AppService, BaseTabComponent, RecoveryToken } from 'tabby-core'
import { SessionRecorder } from './recorder'
import { getRecorderRegistration, setRecorderTab } from './recorderRegistry'

@Component({
    selector: 'recorder-tab',
    template: require('./recorderTab.component.pug'),
    styles: [require('./recorderTab.component.scss')],
})
export class RecorderTabComponent extends BaseTabComponent implements OnInit, OnDestroy {
    @Input() targetId: number

    recorder: SessionRecorder | null = null
    label = ''

    private tabRegistered = false

    constructor (
        injector: Injector,
        private app: AppService,
    ) {
        super(injector)
    }

    ngOnInit (): void {
        // BaseTabComponent has no ngOnInit — no super call
        const reg = getRecorderRegistration(this.targetId)
        this.recorder = reg?.recorder ?? null
        this.label = reg?.label ?? 'pane closed'
        this.setTitle(`Recorder — ${this.label}`)
        this.icon = 'fas fa-circle-dot'
        if (reg) {
            setRecorderTab(this.targetId, this)
            this.tabRegistered = true
        }
    }

    /** Select this tab's root in the tab strip (re-summon from the pane). */
    focusSelf (): void {
        const root = this.topmostParent
        if (root && (this.app.tabs as any[]).includes(root)) {
            this.app.selectTab(root as never)
        }
    }

    async getRecoveryToken (): Promise<RecoveryToken | null> {
        return null  // session data is runtime-only; nothing worth recovering
    }

    ngOnDestroy (): void {
        if (this.tabRegistered) {
            setRecorderTab(this.targetId, null)
            const reg = getRecorderRegistration(this.targetId)
            reg?.onTabClosed?.()
        }
        super.ngOnDestroy()
    }
}
