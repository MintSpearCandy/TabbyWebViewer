/**
 * End-to-end hotkey debugging against an isolated Tabby instance.
 *
 * Prereqs (set up by scripts/e2e-setup.sh or manually):
 *   - test-env/tabby-debug-cfg/ with config.yaml (hotkeys) and the plugin in
 *     plugins/node_modules/
 *   - Tabby launched with TABBY_CONFIG_DIRECTORY=<cfg> --remote-debugging-port=9223
 *
 * Drives the real UI via CDP: opens a Web viewer pane, navigates it, focuses
 * the page, dispatches the Ctrl+Shift+D chord, and dumps the plugin's
 * [webviewer-debug] console output plus any exceptions.
 *
 *   node scripts/e2eDebug.js
 */
const { execSync } = require('child_process')

const PORT = 9223
const URL_TO_LOAD = 'https://example.com'
const CHORD = { ctrl: true, shift: true, key: 'D', code: 'KeyD', vk: 68 }

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getJson (path) {
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`)
    return res.json()
}

class CdpSession {
    constructor (ws) {
        this.ws = ws
        this.id = 0
        this.pending = new Map()
        this.listeners = []
        ws.addEventListener('message', ev => {
            const msg = JSON.parse(ev.data)
            if (msg.id !== undefined && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id)
                this.pending.delete(msg.id)
                msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result)
            } else {
                this.listeners.forEach(l => l(msg))
            }
        })
    }
    static async connect (url) {
        const ws = new WebSocket(url)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        return new CdpSession(ws)
    }
    send (method, params = {}) {
        const id = ++this.id
        this.ws.send(JSON.stringify({ id, method, params }))
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
    }
    on (fn) { this.listeners.push(fn) }
    close () { this.ws.close() }
}

async function evaluate (session, expression) {
    const r = await session.send('Runtime.evaluate', { expression, returnByValue: true })
    const inner = r.result || {}
    if (inner.exceptionDetails) {
        throw new Error('evaluate failed: ' + JSON.stringify(inner.exceptionDetails.exception?.description || inner.exceptionDetails.exception?.text || inner.exceptionDetails.text))
    }
    return inner.result ? inner.result.value : undefined
}

async function click (session, x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
        await session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
}

const MOD = { ctrl: 2, shift: 8, alt: 1, meta: 4 }

async function dispatchChord (session, chord) {
    const mods = (chord.ctrl ? MOD.ctrl : 0) | (chord.shift ? MOD.shift : 0) | (chord.alt ? MOD.alt : 0)
    // modifiers first
    if (chord.ctrl) {
        await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: MOD.ctrl })
    }
    if (chord.shift) {
        await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: mods })
    }
    await session.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: chord.key, code: chord.code, windowsVirtualKeyCode: chord.vk, modifiers: mods,
    })
    await sleep(80)
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: chord.key, code: chord.code, windowsVirtualKeyCode: chord.vk, modifiers: mods })
    if (chord.shift) {
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: mods & ~MOD.shift })
    }
    if (chord.ctrl) {
        await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: mods & ~MOD.ctrl & ~MOD.shift })
    }
}

async function main () {
    // wait for the debug endpoint
    let targets
    for (let i = 0; i < 60; i++) {
        try {
            targets = await getJson('/json/list')
            break
        } catch {
            await sleep(1000)
        }
    }
    if (!targets) {
        throw new Error('Tabby debug port never came up on ' + PORT)
    }
    const pages = targets.filter(t => t.type === 'page')
    // Tabby main window = the biggest page target; WebContentsView panes appear later
    let main = pages.find(t => t.url.includes('index.html')) || pages[0]
    const mainSession = await CdpSession.connect(main.webSocketDebuggerUrl)

    const consoleLines = []
    mainSession.on(msg => {
        if (msg.method === 'Runtime.consoleAPICalled') {
            const text = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            consoleLines.push(`[${msg.params.type}] ${text}`)
        } else if (msg.method === 'Runtime.exceptionThrown') {
            consoleLines.push('[EXCEPTION] ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text))
        }
    })
    await mainSession.send('Runtime.enable')

    // dismiss any first-run modal if present
    await sleep(3000)
    const modal = await evaluate(mainSession, `(() => {
        const b = document.querySelector('.modal-dialog .modal-footer button:last-child, .modal .btn:last-child')
        if (!b) return null
        const r = b.getBoundingClientRect()
        b.click()
        return { clicked: b.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2 }
    })()`)
    console.log('first-run modal dismissed:', JSON.stringify(modal))
    await sleep(500)

    // find and click the "Web viewer" entry
    let opened = false
    for (let attempt = 0; attempt < 5 && !opened; attempt++) {
        const spot = await evaluate(mainSession, `(() => {
            const snap = document.evaluate("//*[normalize-space(text())='Web viewer']", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            let best = null
            for (let i = 0; i < snap.snapshotLength; i++) {
                const el = snap.snapshotItem(i)
                const r = el.getBoundingClientRect()
                if (r.width > 5 && r.height > 5 && (!best || r.width * r.height < best.w)) {
                    best = { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width * r.height }
                }
            }
            return best
        })()`)
        if (!spot) {
            throw new Error('no "Web viewer" entry found in the UI')
        }
        await click(mainSession, spot.x, spot.y)
        for (let i = 0; i < 20; i++) {
            await sleep(250)
            if (await evaluate(mainSession, `!!document.querySelector('.webviewer-toolbar')`)) {
                opened = true
                break
            }
        }
    }
    console.log('webviewer pane opened:', opened)
    if (!opened) {
        throw new Error('pane did not open after clicking')
    }

    // the address bar should be autofocused — type the URL and press Enter
    await sleep(800)
    await mainSession.send('Input.insertText', { text: URL_TO_LOAD })
    await mainSession.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await mainSession.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })

    // wait for the pane's page target to appear and load
    let pageTarget = null
    for (let i = 0; i < 40; i++) {
        await sleep(500)
        const list = (await getJson('/json/list')).filter(t => t.type === 'page' && t.webSocketDebuggerUrl)
        const fresh = list.find(t => t.id !== main.id && !t.url.startsWith('devtools'))
        if (fresh) {
            pageTarget = fresh
            try {
                const s = await CdpSession.connect(fresh.webSocketDebuggerUrl)
                const state = await evaluate(s, 'document.readyState')
                s.close()
                if (state === 'complete' || state === 'interactive') {
                    break
                }
            } catch { /* target warming up */ }
        }
    }
    console.log('page target:', pageTarget ? `${pageTarget.id} ${pageTarget.url.slice(0, 60)}` : 'NOT FOUND')

    consoleLines.length = 0  // keep only the interesting part
    const pageSession = await CdpSession.connect(pageTarget.webSocketDebuggerUrl)

    // click into the page to give it keyboard focus
    await click(pageSession, 200, 200)
    await sleep(600)
    const pageFocusedLog = await evaluate(mainSession,
        `JSON.stringify((window.pluginModules || []).length) + ' plugins; activeElement=' + (document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : 'none')`)
    console.log('main-window DOM state:', pageFocusedLog)

    // THE EXPERIMENT: dispatch Ctrl+Shift+D into the page
    console.log('\n=== dispatching Ctrl+Shift+D into the page ===')
    await dispatchChord(pageSession, CHORD)
    await sleep(2000)

    console.log('=== console output during experiment ===')
    const interesting = consoleLines.filter(l => l.includes('webviewer') || l.includes('webviewer-debug') || l.includes('HOTKEY') || l.includes('hotkey') || l.includes('EXCEPTION'))
    console.log(interesting.length ? interesting.join('\n') : '(no webviewer-related console output)')

    // how many panes exist now? (did a split happen?)
    const panes = await evaluate(mainSession, `document.querySelectorAll('.webviewer-toolbar').length`)
    console.log('\nwebviewer pane count after chord:', panes)

    mainSession.close()
    pageSession.close()
}

main().catch(e => {
    console.error('E2E FAILED:', e.message)
    process.exit(1)
})
