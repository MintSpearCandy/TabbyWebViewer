/**
 * Multi-split repro v2 — CDP Input.dispatchKeyEvent with autoRepeat:true,
 * which sets the real repeat flag (KeyboardEvent.repeat on the DOM,
 * input.isAutoRepeat in before-input-event), exactly like OS key repeat.
 *
 *   node scripts/multiSplitTest.js [chords]
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

const MOD = { ctrl: 2, shift: 8 }
const vk = { Control: 17, Shift: 16, d: 68, D: 68 }

/** Dispatch a synthetic DOM KeyboardEvent on the main window (repeat flag
 *  settable — matches what OS auto-repeat looks like to Tabby + the guard). */
const domKey = (ms, type, key, code, mods, repeat = false) => evaluate(ms, `(() => {
    document.dispatchEvent(new KeyboardEvent('${type}', {
        key: '${key}', code: '${code}', bubbles: true, cancelable: true,
        ctrlKey: ${!!mods.ctrl}, shiftKey: ${!!mods.shift}, repeat: ${repeat},
    }))
    return 'ok'
})()`)

/** One held chord as REAL OS repeat would look on the DOM. */
async function heldChordDom (ms, label, repeatTicks) {
    const before = await evaluate(ms, PANE_COUNT)
    await domKey(ms, 'keydown', 'Control', 'ControlLeft', {})
    await sleep(60)
    await domKey(ms, 'keydown', 'Shift', 'ShiftLeft', { ctrl: true })
    await sleep(60)
    await domKey(ms, 'keydown', 'd', 'KeyD', { ctrl: true, shift: true })
    await sleep(80)
    for (let i = 0; i < repeatTicks; i++) {
        await domKey(ms, 'keydown', 'd', 'KeyD', { ctrl: true, shift: true }, true)
        await sleep(35)
    }
    await domKey(ms, 'keyup', 'd', 'KeyD', { ctrl: true, shift: true })
    await domKey(ms, 'keyup', 'Shift', 'ShiftLeft', { ctrl: true })
    await domKey(ms, 'keyup', 'Control', 'ControlLeft', {})
    await sleep(1500)
    const after = await evaluate(ms, PANE_COUNT)
    const n = after - before
    console.log(`${label}: panes ${before} → ${after}  (${n} split${n === 1 ? '' : 's'} from ONE held chord)`)
    return n
}

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = targets.filter(t => t.type === 'page')
    const mainT = pages.find(t => t.url.includes('index'))
    if (!mainT) throw new Error('main window not found')
    const ms = await connect(mainT.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/hotkey-guard|Matched hotkey split/.test(t)) logs.push(t.slice(0, 110))
        }
    })
    await ms.send('Runtime.enable')

    // open a webviewer pane with a URL if none
    if (await evaluate(ms, PANE_COUNT) === 0) {
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
            if (await evaluate(ms, PANE_COUNT) > 0) break
        }
        await sleep(500)
        await ms.send('Input.insertText', { text: 'https://example.com' })
        await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
        await sleep(4000)
    }
    console.log('starting panes:', await evaluate(ms, PANE_COUNT))

    const ticks = parseInt(process.argv[2] || '8')

    // Phase 1: page-forwarding path — held chord + repeat ticks WITHOUT the
    // isAutoRepeat flag (exactly what a repeat looks like after crossing to
    // a pane whose RenderWidget has no key history — the user's cascade)
    const pageSend = ev => evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const v = r.getCurrentWindow().contentView.children.find(v => (v.webContents.getURL() || '').startsWith('https'))
        if (!v) return 'no-view'
        v.webContents.sendInputEvent(${JSON.stringify(ev)})
        return 'sent'
    })()`)
    {
        const before = await evaluate(ms, PANE_COUNT)
        await pageSend({ type: 'keyDown', keyCode: 'Control' })
        await sleep(60)
        await pageSend({ type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
        await sleep(60)
        await pageSend({ type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await sleep(80)
        for (let i = 0; i < ticks; i++) {
            await pageSend({ type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
            await sleep(35)
        }
        await pageSend({ type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
        await pageSend({ type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
        await pageSend({ type: 'keyUp', keyCode: 'Control' })
        await sleep(2000)
        const after = await evaluate(ms, PANE_COUNT)
        console.log(`B. repeat→页面wc 无标志 (跨窗格级联场景): panes ${before} → ${after}  (${after - before} splits)`)
    }

    // Phase 2: repeats on the DOM as seen with keyboard-in-DOM (guard's target
    // scenario — OS auto-repeat reaching Tabby's main DOM)
    const a = await heldChordDom(ms, 'A. repeat→DOM (synthetic KeyboardEvent repeat:true)', ticks)

    console.log('\nengine/guard log lines:')
    console.log(logs.slice(-20).join('\n') || '(none)')
    console.log(`\nRESULT: DOM-repeats → ${a} splits (guard absent: many; guard active: 1)`)
    ms.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
