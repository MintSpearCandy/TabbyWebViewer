/** Pure-function tests for src/recorder/filters.ts (compiled to test-build/recorder/filters.js). */
const assert = require('assert')
const { parseNetworkFilter, parseStatusPredicate, isStaticAsset } = require('../test-build/recorder/filters')

let passed = 0

function eq (actual, expected, label) {
    assert.strictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    passed++
}

/** Minimal NetworkEntry fixture. */
function entry (over = {}) {
    return Object.assign({
        id: 1, requestId: 'r1', t: 0, wallTimeMs: 0,
        url: 'https://api.example.com/v1/users?page=2', domain: 'api.example.com',
        method: 'GET', resourceType: 'xhr', status: 200, statusText: 'OK',
        mimeType: 'application/json', requestHeaders: {}, responseHeaders: {},
        encodedDataLength: 512, initiator: 'script', state: 'done',
        durationMs: 40, responseBodyBase64: false, hasBody: true,
    }, over)
}

// ------------------------------------------------------------ parse errors
eq(parseNetworkFilter('-').ok, false, 'lone dash → error')
eq(parseNetworkFilter('api -').error.includes("after '-'"), true, 'lone dash message')
eq(parseNetworkFilter('foo:bar').error, 'Unknown filter key "foo"', 'unknown key')
eq(parseNetworkFilter('--domain:x').error, 'Unknown filter key "-domain"', 'double dash → unknown key')
eq(parseNetworkFilter('method:').error, 'Missing value for "method"', 'empty value')
eq(parseNetworkFilter('/x/g').ok, false, 'unsupported regex flag rejected')
eq(parseNetworkFilter('/[/').ok, false, 'invalid regex rejected')
eq(parseNetworkFilter('has:foo').ok, false, 'has: unknown value')
eq(parseNetworkFilter('status:abc').ok, false, 'bad status value')
eq(parseNetworkFilter('status:>=x').ok, false, 'bad status operator')
eq(parseNetworkFilter('status:99').ok, false, 'status needs 3 digits')
eq(parseNetworkFilter('status:6xx').ok, false, 'status class limited to 1-5xx')
eq(parseNetworkFilter('foo:bar').test(entry()), true, 'parse error → match-all (typo safety)')

// ------------------------------------------------------------ substring / regex
eq(parseNetworkFilter('users').test(entry()), true, 'substring hit')
eq(parseNetworkFilter('USERS').test(entry()), true, 'substring case-insensitive')
eq(parseNetworkFilter('orders').test(entry()), false, 'substring miss')
eq(parseNetworkFilter('-users').test(entry()), false, 'negated substring')
eq(parseNetworkFilter('/v1\\/users/').test(entry()), true, 'regex hit')
eq(parseNetworkFilter('/V1\\/USERS/i').test(entry()), true, 'regex i flag')
eq(parseNetworkFilter('/V1\\/USERS/').test(entry()), false, 'regex case-sensitive')
eq(parseNetworkFilter('/api/users').test(entry()), false, 'single slash → substring miss')

// ------------------------------------------------------------ predicates
eq(parseNetworkFilter('method:get').test(entry()), true, 'method case-insensitive')
eq(parseNetworkFilter('method:POST').test(entry()), false, 'method mismatch')
eq(parseNetworkFilter('Method:GET').test(entry()), true, 'key case-insensitive')
eq(parseNetworkFilter('domain:example').test(entry()), true, 'domain substring')
eq(parseNetworkFilter('domain:other.com').test(entry()), false, 'domain miss')
eq(parseNetworkFilter('mime:json').test(entry()), true, 'mime substring')
eq(parseNetworkFilter('type:xhr').test(entry()), true, 'type exact')
eq(parseNetworkFilter('type:doc').test(entry({ resourceType: 'document' })), true, 'type alias doc')
eq(parseNetworkFilter('type:img').test(entry({ resourceType: 'image' })), true, 'type alias img')
eq(parseNetworkFilter('type:js').test(entry({ resourceType: 'script' })), true, 'type alias js')
eq(parseNetworkFilter('type:fetch').test(entry({ resourceType: 'fetch' })), true, 'type unaliased value')
eq(parseNetworkFilter('has:body').test(entry()), true, 'has:body true')
eq(parseNetworkFilter('has:body').test(entry({ hasBody: false })), false, 'has:body false')

// ------------------------------------------------------------ status
eq(parseNetworkFilter('status:200').test(entry()), true, 'status exact')
eq(parseNetworkFilter('status:404').test(entry()), false, 'status exact miss')
eq(parseNetworkFilter('status:2xx').test(entry()), true, 'status class')
eq(parseNetworkFilter('status:4xx').test(entry()), false, 'status class miss')
eq(parseNetworkFilter('status:>=200').test(entry()), true, 'status >=')
eq(parseNetworkFilter('status:>=400').test(entry()), false, 'status >= miss')
eq(parseNetworkFilter('status:>199').test(entry()), true, 'status >')
eq(parseNetworkFilter('status:<300').test(entry()), true, 'status <')
eq(parseNetworkFilter('status:<=200').test(entry()), true, 'status <=')
eq(parseNetworkFilter('status:3xx').test(entry({ status: 302, state: 'redirect' })), true, 'redirect entry status')
eq(parseNetworkFilter('status:200').test(entry({ status: null, state: 'pending' })), false, 'pending fails status')
eq(parseNetworkFilter('status:4xx').test(entry({ status: null })), false, 'pending fails status class')

// ------------------------------------------------------------ combos
eq(parseNetworkFilter('api -type:image method:GET').test(entry()), true, 'AND combo hit')
eq(parseNetworkFilter('api type:image').test(entry()), false, 'AND combo miss')
eq(parseNetworkFilter('-type:xhr').test(entry()), false, 'negated predicate')
eq(parseNetworkFilter('  ').test(entry()), true, 'whitespace-only → match-all')
eq(parseNetworkFilter('').test(entry()), true, 'empty → match-all')

// ------------------------------------------------------------ direct helpers
eq(typeof parseStatusPredicate('4xx'), 'function', 'parseStatusPredicate ok → function')
eq(parseStatusPredicate('abc'), 'Invalid status value "abc" (expected 404, 4xx, >=400, <300, …)', 'parseStatusPredicate error string')
eq(isStaticAsset(entry({ resourceType: 'image' })), true, 'static: image')
eq(isStaticAsset(entry({ resourceType: 'font' })), true, 'static: font')
eq(isStaticAsset(entry({ resourceType: 'stylesheet' })), true, 'static: stylesheet')
eq(isStaticAsset(entry({ resourceType: 'SCRIPT' })), true, 'static: case-insensitive')
eq(isStaticAsset(entry()), false, 'static: xhr is not static')
eq(isStaticAsset(entry({ resourceType: 'document' })), false, 'static: document is not static')

console.log(`[ok] filter tests: ${passed} assertions passed`)
