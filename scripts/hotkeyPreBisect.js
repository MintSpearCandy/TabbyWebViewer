/** Incremental-prelude bisect: start from a bare control chord, then add the
 *  debugKitVerify prelude ingredients one at a time (exception injection →
 *  FOCUS_STATE remote eval → pane nav + blur). The first phase whose Ctrl-Tab
 *  stops matching identifies the poison. Keydump shows DOM arrival. */
const PORT = process.env.CDP_PORT || 9231

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    const log = []
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/hotkey|keydump|phase/.test(text)) log.push('    ' + text)
        }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value
    await send('Runtime.enable')

    await evaluate(`(() => {
        if (window.__keydump) return
        window.__keydump = true
        for (const t of ['keydown', 'keyup']) {
            document.addEventListener(t, e => console.debug('[keydump]', t, 'key=' + e.key, 'ctrl=' + e.ctrlKey, 'shift=' + e.shiftKey), true)
        }
    })()`)

    const chord = async label => {
        await evaluate(`console.log('[phase] ${label}')`)
        log.push(`=== ${label} ===`)
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await new Promise(r => setTimeout(r, 900))
    }

    // P0: bare control
    await chord('P0 bare control')

    // P1: + exception injection (as debugKitVerify does)
    await evaluate(`console.log('[phase-ign] marker'); setTimeout(() => { throw new Error('bisect exception') }, 0)`)
    await new Promise(r => setTimeout(r, 1200))
    await chord('P1 after exception injection')

    // P2: + FOCUS_STATE eval (@electron/remote touch)
    await evaluate(`(() => {
        const r = require('@electron/remote')
        const wc = r.getBuiltin('webContents').getFocusedWebContents()
        const views = r.getCurrentWindow().contentView.children.map(v => v.webContents.getURL().slice(0, 40))
        return JSON.stringify({ focusedWc: wc ? wc.getURL().slice(0, 40) : null, views })
    })()`)
    await chord('P2 after FOCUS_STATE remote eval')

    // P3: + pane navigation + settle + blur (full verify replica)
    const run = Date.now()
    await evaluate(`(() => {
        const el = document.querySelector('webviewer-tab .webviewer-address')
        el.value = 'example.com/?run${run}'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 700))
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        if (list.some(t => t.url.includes(`run${run}`))) break
    }
    await new Promise(r => setTimeout(r, 1200))
    await evaluate(`document.activeElement && document.activeElement !== document.body ? document.activeElement.blur() : 0`)
    await chord('P3 full verify replica (nav+blur)')

    console.log(log.join('\n'))
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
