/** Copy the freshly built plugin into BOTH candidate plugin dirs (portable
 *  data dir wins at load, debug-cfg as fallback). */
const fs = require('fs')
const path = require('path')
const src = path.resolve(__dirname, '..')
for (const dst of [
    path.resolve(__dirname, '..', 'test-env', 'tabby-port', 'data', 'plugins', 'node_modules', 'tabby-webviewer'),
    path.resolve(__dirname, '..', 'test-env', 'tabby-debug-cfg', 'plugins', 'node_modules', 'tabby-webviewer'),
]) {
    if (!fs.existsSync(path.dirname(dst))) {
        console.log('skip (missing dir)', dst)
        continue
    }
    fs.rmSync(path.join(dst, 'dist'), { recursive: true, force: true })
    fs.cpSync(path.join(src, 'dist'), path.join(dst, 'dist'), { recursive: true })
    fs.copyFileSync(path.join(src, 'package.json'), path.join(dst, 'package.json'))
    console.log('updated', dst)
}
