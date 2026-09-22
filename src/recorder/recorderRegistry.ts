/**
 * @hidden
 * Panes publish their SessionRecorder here so detached recorder TABS can find
 * the session of the pane they were opened for (keyed by the pane's
 * webContents id — the same key ViewerView.liveIds uses for app-level
 * attribution). The tab registers itself back so the pane's record button can
 * re-summon (focus) it instead of toggling recording off.
 */
import { SessionRecorder } from './recorder'

/** Minimal structural type — avoids a circular import with the tab component. */
export interface RecorderTabHandle {
    focusSelf (): void
}

export interface RecorderRegistration {
    recorder: SessionRecorder
    /** Pane label (host name) shown in the detached tab title. */
    label: string
    /** Live detached tab for this recorder, if any. */
    tab: RecorderTabHandle | null
    /** Pane-side hook fired when the detached tab closes. */
    onTabClosed?: () => void
}

const byWebContentsId = new Map<number, RecorderRegistration>()

export function registerRecorder (webContentsId: number, recorder: SessionRecorder, label: string): void {
    byWebContentsId.set(webContentsId, { recorder, label, tab: null })
}

export function unregisterRecorder (webContentsId: number): void {
    byWebContentsId.delete(webContentsId)
}

export function getRecorderRegistration (webContentsId: number): RecorderRegistration | undefined {
    return byWebContentsId.get(webContentsId)
}

export function setRecorderTab (webContentsId: number, tab: RecorderTabHandle | null): void {
    const reg = byWebContentsId.get(webContentsId)
    if (reg) {
        reg.tab = tab
    }
}
