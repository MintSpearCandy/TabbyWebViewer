/** Focused chord test: force page focus, deliver q, then Ctrl+Shift+D. */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9233

async function connect (url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    const listeners = []
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) {
            pend.get(m.id)(m)
            pend.delete(m.id)
        } else {
            listeners.forEach(l => l(m))
        }
    })
    return {
        send: (method, params = {}) => {
            const i = ++id
            ws.send(JSON.stringify({ id: i, method, params }))
            return new Promise(r => pend.set(i, r))
        },
        on: fn => listeners.push(fn),
        close: () => ws.close(),
    }
}

async function evaluate (s, expression) {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true })
    const inner = r.result || {}
    if (inner.exceptionDetails) {
        throw new Error(String((inner.exceptionDetails.exception || {}).description || '').slice(0, 200))
    }
    return inner.result ? inner.result.value : undefined
}

async function key (s, type, k, code, vk, modifiers = 0) {
    await s.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers })
}

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = targets.filter(t => t.type === 'page')
    const main = pages.find(t => t.url.includes('index'))
    const page = pages.find(t => t.url.startsWith('https'))
    if (!main || !page) {
        throw new Error('missing targets: ' + pages.map(t => t.url.slice(0, 40)).join(', '))
    }
    const ms = await connect(main.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/webviewer-debug|hotkey|HOTKEY/i.test(t)) logs.push(t.slice(0, 120))
        }
    })
    await ms.send('Runtime.enable')

    // force page webContents focus via remote
    console.log('force focus:', await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        ;(r.getCurrentWindow().contentView.children || []).forEach(v => {
            if (v.webContents.getURL().startsWith('https')) v.webContents.focus()
        })
        return 'done'
    })()`))

    const ps = await connect(page.webSocketDebuggerUrl)
    console.log('page hasFocus:', await evaluate(ps, 'document.hasFocus()'))

    await evaluate(ps, "window.__k=[];window.addEventListener('keydown',e=>window.__k.push(e.key+(e.ctrlKey?'C':'')+(e.shiftKey?'S':'')),true)")
    logs.length = 0

    // q first
    await key(ps, 'keyDown', 'q', 'KeyQ', 81)
    await sleep(120)
    await key(ps, 'keyUp', 'q', 'KeyQ', 81)
    await sleep(300)
    console.log('q received by page DOM:', await evaluate(ps, 'JSON.stringify(window.__k)'))

    // Ctrl+Shift+D chord
    await key(ps, 'rawKeyDown', 'Control', 'ControlLeft', 17, 2)
    await sleep(70)
    await key(ps, 'rawKeyDown', 'Shift', 'ShiftLeft', 16, 10)
    await sleep(70)
    await key(ps, 'keyDown', 'D', 'KeyD', 68, 10)
    await sleep(130)
    await key(ps, 'keyUp', 'D', 'KeyD', 68, 10)
    await key(ps, 'keyUp', 'Shift', 'ShiftLeft', 16, 2)
    await key(ps, 'keyUp', 'Control', 'ControlLeft', 17, 0)
    await sleep(1500)

    console.log('page DOM saw:', await evaluate(ps, 'JSON.stringify(window.__k)'))
    console.log('panes now:', await evaluate(ms, "document.querySelectorAll('.webviewer-toolbar').length"))
    console.log('--- engine/plugin logs during chord ---')
    console.log(logs.join('\n') || '(none)')
    ms.close()
    ps.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
