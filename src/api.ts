import { ConnectableProfile } from 'tabby-core'

export interface WebViewerOptions {
    /** Home / current URL. Empty string shows the "enter a URL" placeholder. */
    url: string
    /**
     * Browsing identity. `null` = generate a fresh per-pane partition on
     * first init (template / Quick Connect default); a stable id reuses the
     * same cookie jar across restarts and duplicated tabs.
     */
    partitionId: string | null
    /** Trust this server's self-signed certificates (partition-scoped). */
    ignoreCertErrors: boolean
}

export interface WebViewerProfile extends ConnectableProfile {
    options: WebViewerOptions
}

export const WEBVIEWER_PROFILE_TYPE = 'webviewer'

export function newPartitionId (): string {
    // No crypto.randomUUID: not in TS 4.2's dom lib
    return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

export function partitionName (partitionId: string): string {
    return 'persist:webviewer-' + partitionId
}

export function makeWebViewerProfile (options: Partial<WebViewerOptions>): WebViewerProfile {
    return {
        id: `webviewer:${Date.now().toString(36)}`,
        type: WEBVIEWER_PROFILE_TYPE,
        name: 'Web viewer',
        group: '',
        options: {
            url: '',
            partitionId: null,
            ignoreCertErrors: false,
            ...options,
        },
        icon: 'fas fa-globe',
        color: null,
        disableDynamicTitle: false,
        behaviorOnSessionEnd: 'keep',
        weight: 0,
        isBuiltin: false,
        isTemplate: false,
        clearServiceMessagesOnConnect: false,
    } as WebViewerProfile
}

/**
 * Normalize an address-bar input into a URL, or null for empty input.
 * Bare localhost / IPv4 hosts default to http:// (typical for server admin
 * pages), everything else to the configured default scheme.
 */
export function normalizeUrl (input: string, defaultScheme = 'https'): string | null {
    const s = input.trim()
    if (!s) {
        return null
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
        return s
    }
    const host = /^[^/?#]+/.exec(s)![0]
    const local = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|\[::1\])(?::\d+)?/i.test(host)
    return (local ? 'http://' : `${defaultScheme}://`) + s
}

export function hostnameOf (url: string): string {
    try {
        return new URL(url).hostname
    } catch {
        return url
    }
}

// Quick Connect matching: leave `user@host` to SSH, reject non-http(s) schemes.
// Bare hosts are accepted only when they look like localhost / an IPv4 / a
// dotted domain name, optionally with a port and path.
const QC_HOST = /^(localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?::\d{1,5})?(?:[/?#].*)?$/i

/**
 * Parse a Quick Connect query into a URL this provider can handle, or null.
 * Returns the normalized URL (scheme added) when it matches.
 */
export function parseQuickConnectQuery (query: string): string | null {
    const s = query.trim()
    if (!s || /\s/.test(s) || s.includes('@')) {
        return null
    }
    if (/^https?:\/\//i.test(s)) {
        return s
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
        return null  // some other scheme (ssh:, ftp:, ...) — not ours
    }
    return QC_HOST.test(s) ? normalizeUrl(s) : null
}
