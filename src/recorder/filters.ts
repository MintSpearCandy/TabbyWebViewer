/**
 * @hidden
 * DevTools-style filter expression for the network stream. Pure functions —
 * this file is compiled standalone by `npm test`, so it must not import
 * anything beyond the data model.
 *
 * Grammar: space-separated tokens, all must hold (AND). A `-` prefix flips
 * the single following token. Token forms:
 *   bare text      substring on URL (case-insensitive)
 *   /re/ or /re/i  regex on URL (only flag `i` supported; other flag letters
 *                  are a parse error — but a tail like `users` in
 *                  `/api/users` is NOT a flags attempt, so that token is a
 *                  plain substring)
 *   key:value      predicate — method:, type:, domain:, mime:, status:, has:
 *
 * A parse error yields { ok: false, error } with a MATCH-ALL test() so a
 * typo never silently hides everything — the panel surfaces the error
 * instead and keeps showing the unfiltered list.
 */
import { NetworkEntry } from './types'

export interface NetworkFilter {
    ok: boolean
    error: string | null
    test (e: NetworkEntry): boolean
}

export type StatusPredicate = (s: number) => boolean

/** type: value aliases to CDP ResourceType names (both sides lowercase). */
export const TYPE_ALIASES: Record<string, string> = {
    doc: 'document',
    css: 'stylesheet',
    img: 'image',
    js: 'script',
    ws: 'websocket',
}

/**
 * Parses a status: value — exact `404`, class `4xx`, or `>=N` / `<=N` /
 * `>N` / `<N`. Returns an error string on bad input (>=|<= must be tried
 * before >|< so `>=400` doesn't mis-parse).
 */
export function parseStatusPredicate (v: string): StatusPredicate | string {
    const m = /^(>=|<=|>|<)(\d+)$/.exec(v)
    if (m) {
        const n = parseInt(m[2], 10)
        if (m[1] === '>=') {
            return s => s >= n
        } else if (m[1] === '<=') {
            return s => s <= n
        } else if (m[1] === '>') {
            return s => s > n
        } else {
            return s => s < n
        }
    }
    if (/^\d{3}$/.test(v)) {
        const n = parseInt(v, 10)
        return s => s === n
    }
    const cls = /^([1-5])xx$/.exec(v)
    if (cls) {
        const base = parseInt(cls[1], 10) * 100
        return s => s >= base && s < base + 100
    }
    return `Invalid status value "${v}" (expected 404, 4xx, >=400, <300, …)`
}

/** Whether the entry belongs to a static-asset family ("hide static assets" toggle). */
export function isStaticAsset (e: NetworkEntry): boolean {
    return /^(image|font|stylesheet|script|media)$/i.test(e.resourceType)
}

type TokenTest = (e: NetworkEntry) => boolean

const okFilter = (test: TokenTest): NetworkFilter => ({ ok: true, error: null, test })
const errFilter = (error: string): NetworkFilter => ({ ok: false, error, test: () => true })

/** Parses one token into a predicate, or an error message. */
function parseToken (raw: string): TokenTest | string {
    let body = raw
    let negated = false
    if (body.startsWith('-')) {
        negated = true
        body = body.slice(1)
        if (body === '') {
            return `Expected a filter after '-'`
        }
    }
    let test: TokenTest
    const reMatch = /^\/(.+)\/([a-z]*)$/.exec(body)
    // A token starting with '/' only counts as a regex literal when the tail
    // after its last slash is empty, `i`, or made purely of regex-flag
    // letters — `/api/` and `/api/i` are regexes, `/x/g` is a flag error,
    // `/api/users` falls through to the substring branch below.
    const tailIsFlagsAttempt = reMatch !== null
        && [...reMatch[2]].every(c => 'dgimsuy'.includes(c))
    if (reMatch && tailIsFlagsAttempt) {
        const flags = reMatch[2]
        if (flags !== '' && flags !== 'i') {
            return `Unsupported regex flag "${flags}" (only "i")`
        }
        let re: RegExp
        try {
            re = new RegExp(reMatch[1], flags)
        } catch {
            return `Invalid regex: /${reMatch[1]}/`
        }
        test = e => re.test(e.url)
    } else if (body.includes(':')) {
        const idx = body.indexOf(':')
        const key = body.slice(0, idx).toLowerCase()
        const value = body.slice(idx + 1)
        if (value === '') {
            return `Missing value for "${key}"`
        }
        if (key === 'method') {
            const m = value.toLowerCase()
            test = e => e.method.toLowerCase() === m
        } else if (key === 'type') {
            const v = value.toLowerCase()
            const t = TYPE_ALIASES[v] ?? v
            test = e => e.resourceType === t
        } else if (key === 'domain') {
            const d = value.toLowerCase()
            test = e => e.domain.toLowerCase().includes(d)
        } else if (key === 'mime') {
            const m = value.toLowerCase()
            test = e => e.mimeType.toLowerCase().includes(m)
        } else if (key === 'status') {
            const p = parseStatusPredicate(value.toLowerCase())
            if (typeof p === 'string') {
                return p
            }
            // pending entries (status === null) fail every status predicate
            test = e => e.status !== null && p(e.status)
        } else if (key === 'has') {
            if (value.toLowerCase() !== 'body') {
                return `Unknown "has:" value "${value}" (only has:body)`
            }
            test = e => e.hasBody
        } else {
            return `Unknown filter key "${key}"`
        }
    } else {
        const s = body.toLowerCase()
        test = e => e.url.toLowerCase().includes(s)
    }
    return negated ? (e => !test(e)) : test
}

export function parseNetworkFilter (expr: string): NetworkFilter {
    const tokens = expr.trim().split(/\s+/).filter(t => t !== '')
    if (tokens.length === 0) {
        return okFilter(() => true)
    }
    const tests: TokenTest[] = []
    for (const tok of tokens) {
        const t = parseToken(tok)
        if (typeof t === 'string') {
            return errFilter(t)
        }
        tests.push(t)
    }
    return okFilter(e => tests.every(t => t(e)))
}
