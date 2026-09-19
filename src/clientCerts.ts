/**
 * @hidden
 * TLS client-certificate (mTLS) support.
 *
 * Chrome automatically picks a client certificate from the OS store; in
 * Electron nothing is sent unless the app-level 'select-client-certificate'
 * event is handled. This module installs ONE handler (first pane wins) that:
 *   - only decides for requests coming from webviewer panes (other webContents
 *     get the browser-default "first certificate" behaviour),
 *   - auto-selects when the store offers exactly one matching certificate,
 *   - remembers the choice per host,
 *   - asks the user through Tabby's selector when several match.
 *
 * Certificates come from the platform store (Windows: user/machine stores)
 * regardless of the pane's session partition.
 */
import { onSelectClientCertificate } from './electronApi'
import { ViewerView } from './viewHost'

export interface ClientCertDelegate {
    /** Ask the user which certificate to use; resolve with its index or null. */
    choose (host: string, certs: any[]): Promise<number | null>
}

let delegate: ClientCertDelegate | null = null
let installed = false
const choiceByHost = new Map<string, number>()

export function ensureClientCertificateSupport (d: ClientCertDelegate): void {
    delegate = d
    if (installed) {
        return
    }
    installed = true
    onSelectClientCertificate((_event, webContents, url, certList, callback) => {
        const certs = certList ?? []
        try {
            const isOurs = !!webContents && ViewerView.isWebViewerWebContents(webContents.id)
            if (!isOurs) {
                // not a webviewer request — stay out of the way, mirror the
                // browser default so other content keeps working
                callback(certs.length ? certs[0] : undefined)
                return
            }
            const host = safeHost(url)
            const remembered = choiceByHost.get(host)
            if (remembered !== undefined && certs[remembered]) {
                callback(certs[remembered])
                return
            }
            if (certs.length <= 1) {
                if (certs.length === 1) {
                    choiceByHost.set(host, 0)
                }
                callback(certs[0])
                return
            }
            if (!delegate) {
                callback(certs[0])
                return
            }
            delegate.choose(host, certs)
                .then(idx => {
                    if (idx === null || idx === undefined || !certs[idx]) {
                        callback(undefined)
                        return
                    }
                    choiceByHost.set(host, idx)
                    callback(certs[idx])
                })
                .catch(() => callback(undefined))
        } catch {
            callback(certs.length ? certs[0] : undefined)
        }
    })
}

function safeHost (url: string): string {
    try {
        return new URL(url).host
    } catch {
        return url
    }
}

/** Test hook: forget remembered choices. */
export function forgetClientCertChoices (): void {
    choiceByHost.clear()
}
