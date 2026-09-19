/** Split-hotkey double-trigger repro: inject one Ctrl+Shift+S chord, count panes + keydowns.
 *  Usage: CDP_PORT=9251 node scripts/splitDoubleTest.js          (inject + measure)
 *         CDP_PORT=9251 node scripts/splitDoubleTest.js status   (measure only)
 *  Pre: empty-cfg instance already running with --remote-debugging-port=$CDP_PORT
 */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9251

async function connect (url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    })
    return {
        send: (method, params = {}) => {
            const i = ++id
            ws.send(JSON.stringify({ id: i, method, params }))
            return new Promise(r => pend.set(i, r))
        },
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

const MEASURE = `(() => {
    const k = (window.__kd || []).map(e => e.key + (e.ctrlKey ? 'C' : '') + (e.shiftKey ? 'S' : '') + (e.repeat ? '(repeat)' : '') + '@' + Math.round(e.timeStamp))
    return JSON.stringify({
        keydowns: k,
        xterms: document.querySelectorAll('.xterm').length,
        terminalTabs: document.querySelectorAll('app-terminal-tab').length,
        spanners: document.querySelectorAll('.split-tab-spanner').length,
        pluginCount: (window.pluginModules || []).length,
    })
})()`

const INSTALL_RECORDER = `(() => {
    window.__kd = []
    document.addEventListener('keydown', e => window.__kd.push({
        key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey,
        repeat: e.repeat, timeStamp: e.timeStamp,
    }), true)
    return 'recorder installed'
})()`

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) { throw new Error('no main page target') }
    const s = await connect(main.webSocketDebuggerUrl)

    const before = await evaluate(s, MEASURE)
    console.log('BEFORE:', before)

    if (process.argv[2] !== 'status') {
        console.log(await evaluate(s, INSTALL_RECORDER))
        const send = ev => evaluate(s, `require('@electron/remote').getCurrentWebContents().sendInputEvent(${JSON.stringify(ev)})`)
        console.log('--- injecting Ctrl+Shift+S (single chord) ---')
        await send({ type: 'keyDown', keyCode: 'Control' })
        await sleep(70)
        await send({ type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(70)
        await send({ type: 'keyDown', keyCode: 'S', modifiers: ['ctrl', 'shift'] })
        await sleep(150)
        await send({ type: 'keyUp', keyCode: 'S', modifiers: ['ctrl', 'shift'] })
        await send({ type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await send({ type: 'keyUp', keyCode: 'Control' })
        await sleep(2000)
    }

    const after = await evaluate(s, MEASURE)
    console.log('AFTER :', after)
    s.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
