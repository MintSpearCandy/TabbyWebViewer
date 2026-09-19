/** Pure-function tests for src/api.ts (compiled to test-build/api.js). */
const assert = require('assert')
const {
    makeWebViewerProfile, newPartitionId, normalizeUrl, hostnameOf,
    parseQuickConnectQuery, partitionName, WEBVIEWER_PROFILE_TYPE,
} = require('../test-build/api')

let passed = 0

function eq (actual, expected, label) {
    assert.strictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    passed++
}

// ---------------------------------------------------------------- normalizeUrl
eq(normalizeUrl('https://x.com'), 'https://x.com', 'scheme kept')
eq(normalizeUrl('http://x.com'), 'http://x.com', 'http kept')
eq(normalizeUrl('github.com'), 'https://github.com', 'bare domain → https')
eq(normalizeUrl('  example.com/path?q=1 '), 'https://example.com/path?q=1', 'trimmed + path')
eq(normalizeUrl('localhost:3000'), 'http://localhost:3000', 'localhost → http')
eq(normalizeUrl('127.0.0.1:8080/x'), 'http://127.0.0.1:8080/x', 'IP → http')
eq(normalizeUrl('192.168.1.10:8443'), 'http://192.168.1.10:8443', 'private IP → http')
eq(normalizeUrl('10.0.0.5'), 'http://10.0.0.5', '10/8 IP → http')
eq(normalizeUrl('172.16.0.1:9000/x'), 'http://172.16.0.1:9000/x', '172.16/12 IP → http')
eq(normalizeUrl('example.com', 'http'), 'http://example.com', 'defaultScheme override')
eq(normalizeUrl(''), null, 'empty → null')
eq(normalizeUrl('   '), null, 'whitespace → null')

// ---------------------------------------------------------------- hostnameOf
eq(hostnameOf('https://a.b.com/x?y=1'), 'a.b.com', 'hostname extracted')
eq(hostnameOf('not a url'), 'not a url', 'invalid falls back to input')

// ------------------------------------------------------- parseQuickConnectQuery
eq(parseQuickConnectQuery('https://github.com'), 'https://github.com', 'full URL accepted')
eq(parseQuickConnectQuery('http://localhost:3000'), 'http://localhost:3000', 'http URL accepted')
eq(parseQuickConnectQuery('localhost'), 'http://localhost', 'bare localhost accepted')
eq(parseQuickConnectQuery('my.server.com'), 'https://my.server.com', 'bare domain accepted')
eq(parseQuickConnectQuery('192.168.1.10:8443/path'), 'http://192.168.1.10:8443/path', 'IP + port + path accepted')
eq(parseQuickConnectQuery('user@host'), null, 'user@host left to SSH')
eq(parseQuickConnectQuery('git@github.com:org/repo'), null, 'scp-style left to SSH')
eq(parseQuickConnectQuery('ssh://host'), null, 'other scheme rejected')
eq(parseQuickConnectQuery('ftp://mirror.example.com'), null, 'ftp rejected')
eq(parseQuickConnectQuery('chrome://settings'), null, 'chrome rejected')
eq(parseQuickConnectQuery('some host'), null, 'whitespace rejected')
eq(parseQuickConnectQuery(''), null, 'empty rejected')
eq(parseQuickConnectQuery('dashboard#x'), null, 'host without dot rejected')

// ------------------------------------------------------- partitions & profiles
assert(partitionName('abc').startsWith('persist:webviewer-'), 'partition prefix')
eq(partitionName('abc'), 'persist:webviewer-abc', 'partition name')
assert(newPartitionId() !== newPartitionId(), 'partition ids unique')

const p = makeWebViewerProfile({ url: 'https://x.com' })
eq(p.type, WEBVIEWER_PROFILE_TYPE, 'profile type')
eq(p.options.url, 'https://x.com', 'url merged')
eq(p.options.partitionId, null, 'partitionId defaults to null')
eq(p.options.ignoreCertErrors, false, 'ignoreCertErrors defaults off')
const p2 = makeWebViewerProfile({ url: 'https://y.com', partitionId: 'fixed', ignoreCertErrors: true })
eq(p2.options.partitionId, 'fixed', 'partitionId merged')
eq(p2.options.ignoreCertErrors, true, 'ignoreCertErrors merged')

console.log(`[ok] api tests: ${passed} assertions passed`)
