/**
 * Focus-navigation experiment on the isolated Tabby instance (port 9233).
 *
 * Seeds a vertical split — terminal (top) + webviewer (bottom) — via
 * localStorage.tabsRecovery, full-restarts the renderer... no: requires a
 * process restart by the operator. Instead, this script assumes the seeded
 * layout already restored (run seedLayout.js first, then have the operator
 * restart, then run this).
 *
 * Then: focuses the webviewer page, dispatches Ctrl+Alt+Up (webviewer ->
 * terminal) and Ctrl+Alt+Down, and traces:
 *   - which webContents owns the OS keyboard after each step
 *   - the plugin's [webviewer-debug] log lines (focus$/blurred$/handover)
 *   - DOM activeElement in the main window
 */
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function getJson (path) {
    return (await fetch(`http://127.0.0.1:9233${path}`)).json()
}

class S {
    constructor (ws) {
        this.ws = ws
        this.id = 0
        this.pend = new Map()
        this.listeners = []
        ws.addEventListener('message', ev => {
            const m = JSON.parse(ev.data)
            if (m.id !== undefined && this.pend.has(m.id)) {
                this.pend.get(m.id)(m)
                this.pend.delete(m.id)
            } else {
                this.listeners.forEach(l => l(m))
            }
        })
    }
    static async connect (url) {
        const ws = new WebSocket(url)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        return new S(ws)
    }
    send (method, params = {}) {
        const id = ++this.id
        this.ws.send(JSON.stringify({ id, method, params }))
        return new Promise(r => this.pend.set(id, r))
    }
    on (fn) { this.listeners.push(fn) }
}

async function evaluate (s, expression) {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true })
    const inner = r.result || {}
    if (inner.exceptionDetails) {
        throw new Error(String((inner.exceptionDetails.exception || {}).description || inner.exceptionDetails.text).slice(0, 200))
    }
    return inner.result ? inner.result.value : undefined
}

async function keyChord (s, mods, key, code, vk) {
    const MODBITS = { ctrl: 2, alt: 1, shift: 8 }
    const bits = (mods.ctrl ? MODBITS.ctrl : 0) | (mods.alt ? MODBITS.alt : 0) | (mods.shift ? MODBITS.shift : 0)
    const seq = []
    if (mods.ctrl) seq.push({ type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', vk: 17, m: 2 })
    if (mods.alt) seq.push({ type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', vk: 18, m: 2 | 1 })
    if (mods.shift) seq.push({ type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', vk: 16, m: bits })
    for (const e of seq) {
        await s.send('Input.dispatchKeyEvent', { type: e.type, key: e.key, code: e.code, windowsVirtualKeyCode: e.vk, modifiers: e.m })
        await sleep(60)
    }
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers: bits })
    await sleep(100)
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers: bits })
    for (const e of seq.reverse()) {
        await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: e.key, code: e.code, windowsVirtualKeyCode: e.vk, modifiers: e.m & ~e.self })
    }
}

async function main () {
    const targets = await getJson('/json/list')
    const pages = targets.filter(t => t.type === 'page')
    const main = pages.find(t => t.url.includes('index'))
    const page = pages.find(t => t.url.startsWith('https'))
    if (!main || !page) {
        console.log('targets:', pages.map(t => t.url.slice(0, 50)))
        throw new Error('need both main window and a webviewer page target')
    }
    const ms = await S.connect(main.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/webviewer-debug|HOTKEY/.test(t)) logs.push(t)
        }
    })
    await ms.send('Runtime.enable')

    const state = async () => {
        const focused = await evaluate(ms, `(() => {
            const remote = require('@electron/remote')
            const wc = remote.getBuiltin('webContents').getFocusedWebContents()
            const main2 = remote.getCurrentWebContents()
            const kids = (remote.getCurrentWindow().contentView.children || []).map(v => v.webContents.id + ':' + v.webContents.getURL().slice(0, 30))
            return JSON.stringify({ osKeyboard: wc ? wc.id : null, main: main2.id, views: kids, domFocus: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 25) : 'none' })
        })()`)
        return focused
    }

    console.log('=== initial state ===')
    console.log(await state())

    const ps = await S.connect(page.webSocketDebuggerUrl)
    // click into the page to give it keyboard
    for (const type of ['mousePressed', 'mouseReleased']) {
        await ps.send('Input.dispatchMouseEvent', { type, x: 200, y: 150, button: 'left', clickCount: 1 })
    }
    await sleep(700)
    console.log('=== after clicking into page ===')
    console.log(await state())

    logs.length = 0
    console.log('=== dispatch Ctrl+Alt+Up (webviewer -> terminal) ===')
    await keyChord(ps, { ctrl: true, alt: true }, 'ArrowUp', 'ArrowUp', 38)
    await sleep(800)
    console.log(await state())
    console.log('--- logs ---')
    console.log(logs.join('\n') || '(none)')

    logs.length = 0
    console.log('=== dispatch Ctrl+Alt+Down (terminal -> webviewer, keys go to main DOM) ===')
    await keyChord(ms, { ctrl: true, alt: true }, 'ArrowDown', 'ArrowDown', 40)
    await sleep(800)
    console.log(await state())
    console.log('--- logs ---')
    console.log(logs.join('\n') || '(none)')
}

main().catch(e => console.error('FAILED:', e.message))
