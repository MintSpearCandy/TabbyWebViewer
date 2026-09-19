/**
 * Publishing pipeline: test → package → tag → GitHub release with zip asset.
 *
 *     node scripts/release.js                # reset + publish current version
 *     node scripts/release.js --dry-run      # everything except GitHub calls
 *
 * Reset semantics: an existing release (and its tag) for this version is
 * deleted first, so re-publishing the same version is always a clean slate.
 *
 * GitHub credentials come from git's credential helper (nothing is written
 * to disk). The repo is derived from the `origin` remote.
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pkg = require(path.join(root, 'package.json'))
const version = pkg.version
const tagName = `v${version}`
const assetPath = path.join(root, 'release', `${pkg.name}-${version}.zip`)
const dryRun = process.argv.includes('--dry-run')

function fail (msg) {
    console.error(`\n[x] ${msg}`)
    process.exit(1)
}

function run (cmd, args, opts = {}) {
    if (process.platform === 'win32' && cmd === 'npm') {
        cmd = 'cmd'
        args = ['/c', 'npm', ...args]
    }
    const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
    if (r.status !== 0) {
        fail(`command failed: ${cmd} ${args.join(' ')}`)
    }
}

function git (...args) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    return { ok: r.status === 0, out: (r.stdout || '').trim() }
}

function ghToken () {
    const r = spawnSync('git', ['credential', 'fill'], {
        input: 'protocol=https\nhost=github.com\n\n',
        encoding: 'utf8',
    })
    const m = /password=(.+)/.exec(r.stdout || '')
    if (!m) {
        fail('no GitHub credentials — run `git push` once interactively so the credential manager stores them')
    }
    return m[1]
}

function repoSlug () {
    const url = git('remote', 'get-url', 'origin').out
    const m = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(url)
    if (!m) {
        fail(`cannot parse owner/repo from origin: ${url}`)
    }
    return `${m[1]}/${m[2]}`
}

async function api (token, slug, url, { method = 'GET', body, contentType } = {}) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'release-script',
    }
    const init = { method, headers }
    if (body !== undefined) {
        if (Buffer.isBuffer(body)) {
            headers['Content-Type'] = contentType
            init.body = body
        } else {
            headers['Content-Type'] = 'application/json'
            init.body = JSON.stringify(body)
        }
    }
    const res = await fetch(url, init)
    const text = await res.text()
    const json = text ? JSON.parse(text) : null
    return { status: res.status, ok: res.ok, json }
}

function releaseBody () {
    // Lives in the project root: scripts/package.js wipes release/ on every run
    const manual = path.join(root, 'RELEASE_NOTES.md')
    if (fs.existsSync(manual)) {
        return fs.readFileSync(manual, 'utf8')
    }
    return `${pkg.description}\n\nSee [README.md](https://github.com/${repoSlug()}#readme) for details.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)`
}

async function main () {
    console.log(`[1/6] ${pkg.name} ${version} — preflight`)
    if (git('status', '--porcelain').out) {
        fail('working tree is dirty — commit or stash first')
    }
    const slug = repoSlug()
    console.log(`      repo: ${slug}, tag: ${tagName}`)

    console.log('[2/6] Tests + package')
    run('npm', ['test'])
    run('node', ['scripts/package.js'])
    if (!fs.existsSync(assetPath)) {
        fail(`asset not found after packaging: ${assetPath}`)
    }
    const assetBytes = fs.statSync(assetPath).size
    console.log(`      asset: ${path.basename(assetPath)} (${(assetBytes / 1024).toFixed(1)} KB)`)

    console.log('[3/6] Pushing main')
    // Attempt order: first without the (socks5) proxy — the credential
    // manager cannot use socks proxies — then with the user's configured
    // proxy as fallback for when direct access is flaky.
    let pushed = false
    for (const args of [['-c', 'http.https://github.com.proxy=', 'push'], ['push']]) {
        for (let attempt = 1; attempt <= 2 && !pushed; attempt++) {
            const r = spawnSync('git', args, { cwd: root, stdio: 'inherit' })
            if (r.status === 0) {
                pushed = true
                break
            }
            console.error(`      push failed (${args.includes('push') && args.length === 1 ? 'configured proxy' : 'direct'} #${attempt})`)
        }
        if (pushed) {
            break
        }
    }
    if (!pushed) {
        fail('could not push to origin — check network / proxy')
    }

    if (dryRun) {
        console.log('[4/6] --dry-run: skipping GitHub API calls')
        console.log('[5/6] --dry-run: skipping tag / release creation')
        console.log('[6/6] done (dry run)')
        return
    }

    const token = ghToken()
    const base = `https://api.github.com/repos/${slug}`

    console.log('[4/6] Resetting existing release/tag for this version')
    const existing = await api(token, slug, `${base}/releases/tags/${tagName}`)
    if (existing.ok) {
        await api(token, slug, `${base}/releases/${existing.json.id}`, { method: 'DELETE' })
        console.log(`      deleted release ${tagName}`)
    }
    // Tag may exist without a release
    const tagRef = await api(token, slug, `${base}/git/ref/tags/${tagName}`)
    if (tagRef.ok) {
        await api(token, slug, `${base}/git/refs/tags/${tagName}`, { method: 'DELETE' })
        console.log(`      deleted tag ${tagName}`)
    }
    git('tag', '-d', tagName) // local copy, if any

    console.log('[5/6] Creating release')
    const created = await api(token, slug, `${base}/releases`, {
        method: 'POST',
        body: {
            tag_name: tagName,
            target_commitish: 'main',
            name: tagName,
            body: releaseBody(),
            draft: false,
            prerelease: false,
        },
    })
    if (!created.ok) {
        fail(`release creation failed: ${JSON.stringify(created.json).slice(0, 400)}`)
    }
    const releaseId = created.json.id
    console.log(`      ${created.json.html_url}`)

    console.log('[6/6] Uploading asset')
    const uploaded = await api(token, slug,
        `https://uploads.github.com/repos/${slug}/releases/${releaseId}/assets?name=${encodeURIComponent(path.basename(assetPath))}`, {
            method: 'POST',
            body: fs.readFileSync(assetPath),
            contentType: 'application/zip',
        })
    if (!uploaded.ok) {
        fail(`asset upload failed: ${JSON.stringify(uploaded.json).slice(0, 400)}`)
    }

    git('fetch', 'origin', `refs/tags/${tagName}:refs/tags/${tagName}`)
    console.log(`\n[ok] Released ${pkg.name} ${version}`)
    console.log(`     ${created.json.html_url}`)
    console.log(`     ${uploaded.json.browser_download_url}`)
}

main().catch(e => fail(e.message))
