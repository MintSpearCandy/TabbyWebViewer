/**
 * Packages the plugin into a folder + zip that can be dropped into
 * Tabby's plugin directory:  %USERPROFILE%\.tabby\plugins\node_modules\
 *
 * The staged package contains only what Tabby needs to load the plugin:
 *   - package.json (sanitized; keywords must include "tabby-plugin")
 *   - dist/index.js (+ source map)
 *   - README.md
 *
 * Runtime modules (tabby-core, tabby-terminal, @angular/*, rxjs, ...) are
 * resolved from the Tabby app itself at load time and must NOT be bundled —
 * webpack externals already take care of that. Bundled deps (strip-ansi,
 * ansi-colors) are inlined into dist/index.js.
 *
 * Usage:
 *   npm run package           # build + stage release/ + zip
 *   npm run package:install   # same, then copy into Tabby's plugins dir
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const root = path.resolve(__dirname, '..')
const releaseDir = path.join(root, 'release')
const pkg = require(path.join(root, 'package.json'))
const packageName = pkg.name
const stagedDir = path.join(releaseDir, packageName)

function fail (msg) {
    console.error(`\n[x] ${msg}`)
    process.exit(1)
}

function run (cmd, args, opts = {}) {
    // npm is a .cmd on Windows and can only be spawned through the shell
    if (process.platform === 'win32' && cmd === 'npm') {
        cmd = 'cmd'
        args = ['/c', 'npm', ...args]
    }
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
    if (r.status !== 0) {
        fail(`command failed (${cmd} ${args.join(' ')})`)
    }
}

function copyDir (src, dest) {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name)
        const d = path.join(dest, entry.name)
        if (entry.isDirectory()) {
            copyDir(s, d)
        } else {
            fs.copyFileSync(s, d)
        }
    }
}

// ---------------------------------------------------------------- build ----

console.log('[1/4] Building...')
run('npm', ['run', 'build'], { cwd: root })

const distDir = path.join(root, 'dist')
if (!fs.existsSync(path.join(distDir, 'index.js'))) {
    fail('dist/index.js not found after build')
}

// ---------------------------------------------------------------- stage ----

console.log('[2/4] Staging package...')
fs.rmSync(releaseDir, { recursive: true, force: true })
fs.mkdirSync(stagedDir, { recursive: true })

copyDir(distDir, path.join(stagedDir, 'dist'))

// Minimal package.json: everything Tabby's plugin discovery and loader use.
// - keywords ["tabby-plugin"] is REQUIRED for discovery
// - main must point at dist/index.js
// - typings dropped: the webpack build emits no .d.ts
fs.writeFileSync(
    path.join(stagedDir, 'package.json'),
    JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        keywords: pkg.keywords,
        main: 'dist/index.js',
        author: pkg.author || '',
        license: pkg.license,
        peerDependencies: pkg.peerDependencies,
    }, null, 2) + '\n',
)

if (fs.existsSync(path.join(root, 'README.md'))) {
    fs.writeFileSync(path.join(stagedDir, 'README.md'), fs.readFileSync(path.join(root, 'README.md')))
}

// ------------------------------------------------------------------ zip ----

console.log('[3/4] Creating zip...')
const zipPath = path.join(releaseDir, `${packageName}-${pkg.version}.zip`)
if (process.platform === 'win32') {
    run('powershell', [
        '-NoProfile', '-Command',
        `Compress-Archive -Path "${stagedDir}" -DestinationPath "${zipPath}" -Force`,
    ])
} else {
    run('sh', ['-c', `cd "${releaseDir}" && rm -f "${packageName}-${pkg.version}.zip" && zip -r "${packageName}-${pkg.version}.zip" "${packageName}"`])
}

// --------------------------------------------------------------- install ----

// Tabby's config dir is platform-specific (matches Electron's appData):
//   win32:  %APPDATA%\tabby
//   darwin: ~/Library/Application Support/tabby
//   linux:  ~/.config/tabby (or $XDG_CONFIG_HOME/tabby)
function tabbyPluginsDir () {
    if (process.platform === 'win32' && process.env.APPDATA) {
        return path.join(process.env.APPDATA, 'tabby', 'plugins')
    }
    if (process.platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'tabby', 'plugins')
    }
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
    return path.join(xdg, 'tabby', 'plugins')
}

const pluginsDir = tabbyPluginsDir()
const targetDir = path.join(pluginsDir, 'node_modules', packageName)

if (process.argv.includes('--install')) {
    console.log('[4/4] Installing into Tabby plugins directory...')
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(targetDir), { recursive: true })
    copyDir(stagedDir, targetDir)
    console.log(`    installed: ${targetDir}`)
} else {
    console.log('[4/4] Skipped install (run with --install, or npm run package:install)')
}

// -------------------------------------------------------------- summary ----

console.log(`
[ok] Package ready:
     folder : ${stagedDir}
     zip    : ${zipPath}

To install manually, copy the folder to:
     ${targetDir}

then fully exit Tabby (including the tray icon) and start it again —
plugins are only loaded at startup.
`)
