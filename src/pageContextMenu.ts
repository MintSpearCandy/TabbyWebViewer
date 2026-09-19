/**
 * @hidden
 * Context menu for the rendered page, built with Electron's native Menu (it
 * floats above the WebContentsView, no docking needed).
 *
 * Coordinates: context-menu params.x/y are relative to the VIEW, while
 * Menu.popup expects screen coordinates — convert by adding the window's
 * content origin and the view's offset within it. inspectElement() takes
 * view-relative coordinates and gets the raw values.
 */
import { buildMenu, clipboardWriteText, currentWindow } from './electronApi'
import { ViewerView } from './viewHost'

export interface PageMenuHandlers {
    onOpenInNewTab (url: string): void
    onClearBrowsingData (): void
}

export function popupPageContextMenu (view: ViewerView, params: any, h: PageMenuHandlers): void {
    const webContents = view.webContents
    const template: any[] = [
        { label: 'Back', enabled: navState(webContents).canGoBack, click: () => navActions(webContents).back() },
        { label: 'Forward', enabled: navState(webContents).canGoForward, click: () => navActions(webContents).forward() },
        { label: 'Reload', click: () => webContents.reload() },
        { type: 'separator' },
    ]
    if (params.linkURL) {
        template.push(
            { label: 'Open link in new tab', click: () => h.onOpenInNewTab(params.linkURL) },
            { label: 'Copy link address', click: () => clipboardWriteText(params.linkURL) },
            { type: 'separator' },
        )
    }
    if (params.isEditable || params.selectionText) {
        template.push(
            { label: 'Cut', enabled: params.editFlags?.canCut, click: () => webContents.cut() },
            { label: 'Copy', enabled: params.editFlags?.canCopy, click: () => webContents.copy() },
            { label: 'Paste', enabled: params.editFlags?.canPaste, click: () => webContents.paste() },
            { type: 'separator' },
        )
    }
    template.push(
        { label: 'Clear browsing data', click: () => h.onClearBrowsingData() },
        { type: 'separator' },
        { label: 'Inspect element', click: () => webContents.inspectElement(params.x, params.y) },
    )
    const win = currentWindow()
    const content = win.getContentBounds()
    const viewBounds = view.getBounds()
    buildMenu(template).popup({
        window: win,
        x: Math.round(content.x + viewBounds.x + params.x),
        y: Math.round(content.y + viewBounds.y + params.y),
    })
}

function navState (webContents: any): { canGoBack: boolean, canGoForward: boolean } {
    const nav = webContents.navigationHistory
    if (nav) {
        return { canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() }
    }
    return {
        canGoBack: !!webContents.canGoBack?.(),
        canGoForward: !!webContents.canGoForward?.(),
    }
}

function navActions (webContents: any): { back (): void, forward (): void } {
    const nav = webContents.navigationHistory
    if (nav) {
        return { back: () => nav.goBack(), forward: () => nav.goForward() }
    }
    return {
        back: () => webContents.goBack?.(),
        forward: () => webContents.goForward?.(),
    }
}
