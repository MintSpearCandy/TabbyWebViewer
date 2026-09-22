/** Copy the freshly built plugin into BOTH candidate plugin dirs (portable
 *  data dir wins at load, debug-cfg as fallback).
 *
 *  `--app` additionally deploys to the user's REAL Tabby at D:\App\Tabby —
 *  opt-in only: never fold the real environment into the default run.
 *  Restart Tabby afterwards to load the new version. */
const fs = require('fs')
const path = require('path')
const src = path.resolve(__dirname, '..')
const targets = [
    // WebViewer-DEDICATED instance (port 9232) — tabby-port is shared with
    // the GlassTheme workflow, which kills/restarts it at will
    path.resolve(__dirname, '..', 'test-env', 'tabby-wv', 'data', 'plugins', 'node_modules', 'tabby-webviewer'),
    path.resolve(__dirname, '..', 'test-env', 'tabby-port', 'data', 'plugins', 'node_modules', 'tabby-webviewer'),
    path.resolve(__dirname, '..', 'test-env', 'tabby-debug-cfg', 'plugins', 'node_modules', 'tabby-webviewer'),
]
if (process.argv.includes('--app')) {
    targets.push('D:\\App\\Tabby\\data\\plugins\\node_modules\\tabby-webviewer')
}
for (const dst of targets) {
    if (!fs.existsSync(path.dirname(dst))) {
        console.log('skip (missing dir)', dst)
        continue
    }
    fs.rmSync(path.join(dst, 'dist'), { recursive: true, force: true })
    fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
    console.log('updated', dst)
}
