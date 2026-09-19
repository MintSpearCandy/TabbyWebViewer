/**
 * @hidden
 * Single entry point for everything @electron/remote. Tabby's renderer runs
 * with nodeIntegration enabled and Tabby bundles @electron/remote, so the
 * module resolves from the host at runtime (webpack externals keep it out of
 * the bundle).
 *
 * Two hard-won rules:
 *  1. Use a plain CJS require — @electron/remote's entry sets __esModule
 *     without a default export, so an ES default import yields undefined.
 *  2. NEVER use remote.require('electron') — its main-side handler relies on
 *     process.mainModule, which Electron 43 (Node 22) removed. Use
 *     remote.getBuiltin('<module>') for every main-process module instead.
 */
const remote: any = require('@electron/remote')

export function sessionFromPartition (partition: string): any {
    return remote.getBuiltin('session').fromPartition(partition)
}

export function buildMenu (template: any[]): any {
    return remote.getBuiltin('Menu').buildFromTemplate(template)
}

export function clipboardWriteText (text: string): void {
    remote.getBuiltin('clipboard').writeText(text)
}

export function shellOpenExternal (url: string): void {
    remote.getBuiltin('shell').openExternal(url)
}

export function appGetPath (name: string): string {
    return remote.getBuiltin('app').getPath(name)
}

/**
 * Subscribe to app-level client-certificate requests. The handler MUST call
 * `callback` exactly once per event (undefined = reject the request).
 */
export function onSelectClientCertificate (handler: (...args: any[]) => void): void {
    remote.getBuiltin('app').on('select-client-certificate', handler)
}

export function getWebContentsViewClass (): any {
    return remote.getBuiltin('WebContentsView')
}

export function currentWindow (): any {
    return remote.getCurrentWindow()
}

export function currentWebContents (): any {
    return remote.getCurrentWebContents()
}

/** The webContents that currently owns the OS keyboard, or null. */
export function focusedWebContentsId (): number | null {
    try {
        const wc = remote.getBuiltin('webContents').getFocusedWebContents()
        return wc ? wc.id : null
    } catch {
        return null
    }
}
