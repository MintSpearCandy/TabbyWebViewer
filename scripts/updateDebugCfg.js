/** Copy the freshly built plugin into the central debug environment instances
 *  (D:\Env\TabbyEnv). See that env's README / tabby.ps1 for the full workflow.
 *
 *  `--app` additionally deploys to the user's REAL Tabby at D:\App\Tabby —
 *  opt-in only: never fold the real environment into the default run.
 *  Restart the instance afterwards to load the new version. */
const fs = require('fs')
const path = require('path')
const src = path.resolve(__dirname, '..')
const targets = [
    // WebViewer-DEDICATED instance (port 9232); main (9231) is the all-plugins instance
    'D:\\Env\\TabbyEnv\\instances\\wv\\data\\plugins\\node_modules\\tabby-webviewer',
    'D:\\Env\\TabbyEnv\\instances\\main\\data\\plugins\\node_modules\\tabby-webviewer',
]
if (process.argv.includes('--app')) {
    // The real install: portable layout (data\plugins next to the exe) when
    // present, otherwise the installed-app default %APPDATA%\tabby
    const portable = 'D:\\App\\Tabby\\data\\plugins\\node_modules\\tabby-webviewer'
    if (fs.existsSync(path.dirname(path.dirname(portable)))) {
        targets.push(portable)
    } else if (process.env.APPDATA) {
        targets.push(path.join(process.env.APPDATA, 'tabby', 'plugins', 'node_modules', 'tabby-webviewer'))
    }
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
