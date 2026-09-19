/** Chord test via webContents.sendInputEvent (native pipeline). */
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
        throw new Error(String((inner.exceptionDetails.exception || {}).description || '').slice(0, 250))
    }
    return inner.result ? inner.result.value : undefined
}

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    const page = targets.filter(t => t.type === 'page').find(t => t.url.startsWith('https'))
    if (!main || !page) {
        throw new Error('missing targets')
    }
    const ms = await connect(main.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/webviewer-debug|hotkey|HOTKEY/i.test(t)) logs.push(t.slice(0, 130))
        }
    })
    await ms.send('Runtime.enable')
    const ps = await connect(page.webSocketDebuggerUrl)

    // helper that injects via the native pipeline through the page webContents
    const sendInput = ev => evaluate(ms, `(() => {
        const r = require('@electron/remote')
        let done = 'no-view'
        ;(r.getCurrentWindow().contentView.children || []).forEach(v => {
            if (v.webContents.getURL().startsWith('https')) {
                v.webContents.sendInputEvent(${JSON.stringify(ev)})
                done = 'sent'
            }
        })
        return done
    })()`)

    await evaluate(ps, "window.__k=[];window.addEventListener('keydown',e=>window.__k.push(e.key+(e.ctrlKey?'C':'')+(e.shiftKey?'S':'')),true)")
    logs.length = 0

    console.log('q:', await sendInput({ type: 'keyDown', keyCode: 'q' }))
    await sleep(150)
    await sendInput({ type: 'keyUp', keyCode: 'q' })
    await sleep(400)
    console.log('page saw q:', await evaluate(ps, 'JSON.stringify(window.__k)'))

    console.log('--- chord Ctrl+Shift+D via sendInputEvent ---')
    await sendInput({ type: 'keyDown', keyCode: 'Control' })
    await sleep(70)
    await sendInput({ type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sleep(70)
    await sendInput({ type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
    await sleep(130)
    await sendInput({ type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
    await sendInput({ type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sendInput({ type: 'keyUp', keyCode: 'Control' })
    await sleep(2000)

    console.log('page saw:', await evaluate(ps, 'JSON.stringify(window.__k)'))
    console.log('panes now:', await evaluate(ms, "document.querySelectorAll('.webviewer-toolbar').length"))
    console.log('--- logs ---')
    console.log(logs.join('\n') || '(none)')
    ms.close()
    ps.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
