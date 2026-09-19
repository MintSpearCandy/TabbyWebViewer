/**
 * Repro: after splitting with Ctrl+Shift+D, keeping / re-pressing Ctrl+Shift
 * reportedly splits again in the same direction. Drives the exact key
 * sequences through the page webContents (the forwarding path) and watches
 * what the engine matches.
 *
 *   node scripts/chordFollowTest.js
 * Pre: Tabby running with --remote-debugging-port=9231
 */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9231

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
        throw new Error(String((inner.exceptionDetails.exception || {}).description || '').slice(0, 300))
    }
    return inner.result ? inner.result.value : undefined
}

const PANE_COUNT = `[...document.querySelectorAll('webviewer-tab')].length`

/** Send to a page view by INDEX among https children (0 = first pane). */
const sendToPane = (ms, idx, ev) => evaluate(ms, `(() => {
    const r = require('@electron/remote')
    const views = r.getCurrentWindow().contentView.children.filter(v => (v.webContents.getURL() || '').startsWith('https'))
    const v = views[${idx}]
    if (!v) return 'no-view-' + ${idx} + '-of-' + views.length
    v.webContents.sendInputEvent(${JSON.stringify(ev)})
    return 'ok'
})()`)

async function count (ms) {
    return evaluate(ms, PANE_COUNT)
}

async function scenario (ms, label, steps) {
    const before = await count(ms)
    await steps()
    await sleep(1200)
    const after = await count(ms)
    console.log(`${label}: panes ${before} → ${after}  (${after - before} extra split${after - before === 1 ? '' : 's'})`)
    return after - before
}

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const mainT = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!mainT) throw new Error('main window not found')
    const ms = await connect(mainT.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/Matched hotkey|Unmatched hotkey|hotkey-guard/.test(t)) logs.push(t.slice(0, 100))
        }
    })
    await ms.send('Runtime.enable')

    // open a pane if needed
    if (await count(ms) === 0) {
        await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
        await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 })
        await sleep(60)
        await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'E', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: 10 })
        await sleep(100)
        await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'E', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: 10 })
        await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
        await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
        await sleep(1000)
        await evaluate(ms, `(() => {
            const snap = document.evaluate("//*[normalize-space(text())='Web viewer']", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            for (let i = 0; i < snap.snapshotLength; i++) {
                const el = snap.snapshotItem(i)
                const r = el.getBoundingClientRect()
                if (r.width < 5 || r.height < 5) continue
                let row = el
                for (let k = 0; k < 6 && row.parentElement; k++) {
                    row = row.parentElement
                    if (row.tagName === 'LI' || row.tagName === 'A') break
                }
                row.click()
                return 'clicked'
            }
            return 'not-found'
        })()`)
        for (let i = 0; i < 30; i++) {
            await sleep(300)
            if (await count(ms) > 0) break
        }
        await sleep(500)
        await ms.send('Input.insertText', { text: 'https://example.com' })
        await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
        await sleep(4000)
    }
    console.log('starting panes:', await count(ms))
    logs.length = 0

    // ── S1: split with Ctrl+Shift+D, then release all and re-press ONLY
    // Ctrl+Shift quickly — the user's reported bug ─────────────────────────
    await scenario(ms, 'S1 分裂→全松→2s内仅重按Ctrl+Shift', async () => {
        await sendToPane(ms, 0, { type: 'keyDown', keyCode: 'Control' })
        await sleep(60)
        await sendToPane(ms, 0, { type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(60)
        await sendToPane(ms, 0, { type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sleep(300)  // split happens; keyboard follows to pane 1
        // release everything on the NEW pane — per-pane pairing drops every
        // keyup → engine's pressedKeys keep the full 'Ctrl-Shift-D' chord
        await sendToPane(ms, 1, { type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sleep(80)
        await sendToPane(ms, 1, { type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sendToPane(ms, 1, { type: 'keyUp', keyCode: 'Control' })
        await sleep(300)  // still < 2s since the split
        // re-press ONLY the modifiers — engine still thinks D is down
        await sendToPane(ms, 1, { type: 'keyDown', keyCode: 'Control' })
        await sleep(60)
        await sendToPane(ms, 1, { type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(600)
        await sendToPane(ms, 1, { type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sendToPane(ms, 1, { type: 'keyUp', keyCode: 'Control' })
    })

    // ── S2: same split flow but wait > 2s before re-pressing (engine TTL
    // clears the residue — control case) ──────────────────────────────────
    await scenario(ms, 'S2 同上但等2.5s(引擎TTL清残留,对照)', async () => {
        const panes = await count(ms)
        await sendToPane(ms, panes - 1, { type: 'keyDown', keyCode: 'Control' })
        await sleep(60)
        await sendToPane(ms, panes - 1, { type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(60)
        await sendToPane(ms, panes - 1, { type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sleep(300)
        const newPane = await count(ms) - 1
        await sendToPane(ms, newPane, { type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sleep(80)
        await sendToPane(ms, newPane, { type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sendToPane(ms, newPane, { type: 'keyUp', keyCode: 'Control' })
        await sleep(2500)  // > 2s: engine expires the stale chord
        await sendToPane(ms, newPane, { type: 'keyDown', keyCode: 'Control' })
        await sleep(60)
        await sendToPane(ms, newPane, { type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(600)
        await sendToPane(ms, newPane, { type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sendToPane(ms, newPane, { type: 'keyUp', keyCode: 'Control' })
    })

    // ── S3: full chord again after everything settled — should split once ─
    await scenario(ms, 'S3 稳定后再按完整Ctrl+Shift+D(应分裂1次)', async () => {
        const panes = await count(ms)
        await sendToPane(ms, panes - 1, { type: 'keyDown', keyCode: 'Control' })
        await sleep(60)
        await sendToPane(ms, panes - 1, { type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(60)
        await sendToPane(ms, panes - 1, { type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sleep(200)
        await sendToPane(ms, panes - 1, { type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sendToPane(ms, panes - 1, { type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sendToPane(ms, panes - 1, { type: 'keyUp', keyCode: 'Control' })
    })

    console.log('\nengine log:')
    console.log(logs.slice(-30).join('\n') || '(none)')
    ms.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
