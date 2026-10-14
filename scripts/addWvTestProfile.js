/** One-off: ensure the wv test instance has a saved webviewer profile with a
 *  URL and an id (id-less entries are filtered out of the profile tree).
 *  Run while the instance is STOPPED — config.yaml is only read at startup. */
const fs = require('fs')
const p = 'D:/Env/TabbyEnv/instances/wv/data/config.yaml'
let s = fs.readFileSync(p, 'utf8')
if (s.includes('WV Panel Test')) {
    if (s.includes('id: \'webviewer:custom:wv-panel-test\'')) {
        console.log('profile already has id')
        process.exit(0)
    }
    s = s.replace("  - name: 'WV Panel Test'", "  - id: 'webviewer:custom:wv-panel-test'\n    name: 'WV Panel Test'")
} else {
    const entry = [
        'profiles:',
        "  - id: 'webviewer:custom:wv-panel-test'",
        "    name: 'WV Panel Test'",
        "    type: 'webviewer'",
        "    icon: 'fas fa-globe'",
        '    options:',
        "      url: 'https://example.com'",
    ].join('\n')
    if (/^profiles: \[\]$/m.test(s)) {
        s = s.replace(/^profiles: \[\]$/m, entry)
    } else {
        s = entry + '\n' + s
    }
}
fs.writeFileSync(p, s)
console.log('profile id ensured')
