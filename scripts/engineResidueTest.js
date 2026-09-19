/**
 * Isolate the ENGINE's stale-chord semantics: feed the hotkey engine DOM
 * keydowns for Ctrl+Shift+D (split fires), deliberately NEVER send the
 * keyups (what losing keyups across panes looks like), then re-press only
 * Ctrl+Shift — does the engine re-fire split-right from the residue?
 *
 *   node scripts/engineResidueTest.js
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

const PANE_COUNT = `(() => {
    const split = document.querySelector('split-tab')
    const all = split ? split.querySelectorAll(':scope > div > div > *') : []
    return JSON.stringify({
        webviewer: document.querySelectorAll('webviewer-tab').length,
        xterm: document.querySelectorAll('.xterm').length,
    })
})()`

const kd = (ms, key, code, mods) => evaluate(ms, `(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
        key: '${key}', code: '${code}', bubbles: true, cancelable: true,
        ctrlKey: ${!!(mods && mods.ctrl)}, shiftKey: ${!!(mods && mods.shift)}, repeat: false,
    }))
    return 'ok'
})()`)
const ku = (ms, key, code, mods) => evaluate(ms, `(() => {
    document.dispatchEvent(new KeyboardEvent('keyup', {
        key: '${key}', code: '${code}', bubbles: true, cancelable: true,
        ctrlKey: ${!!(mods && mods.ctrl)}, shiftKey: ${!!(mods && mods.shift)},
    }))
    return 'ok'
})()`)

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const mainT = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    const ms = await connect(mainT.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/Matched hotkey|Unmatched/.test(t)) logs.push(t)
        }
    })
    await ms.send('Runtime.enable')

    const n0 = await evaluate(ms, PANE_COUNT)
    console.log('panes:', n0)

    console.log('\n[1] Ctrl↓ Shift↓ D↓ (splits once), NO keyups at all')
    await kd(ms, 'Control', 'ControlLeft', {})
    await sleep(60)
    await kd(ms, 'Shift', 'ShiftLeft', { ctrl: true })
    await sleep(60)
    await kd(ms, 'd', 'KeyD', { ctrl: true, shift: true })
    await sleep(400)
    console.log('   panes:', await evaluate(ms, PANE_COUNT))

    console.log('\n[2] re-press ONLY Ctrl↓ Shift↓ (D was never released engine-side)')
    await kd(ms, 'Control', 'ControlLeft', {})
    await sleep(80)
    await kd(ms, 'Shift', 'ShiftLeft', { ctrl: true })
    await sleep(600)
    console.log('   panes:', await evaluate(ms, PANE_COUNT))

    console.log('\n[3] now release everything (keyups), then press Ctrl+Shift alone')
    await ku(ms, 'd', 'KeyD', { ctrl: true, shift: true })
    await ku(ms, 'Shift', 'ShiftLeft', { ctrl: true })
    await ku(ms, 'Control', 'ControlLeft', {})
    await sleep(300)
    await kd(ms, 'Control', 'ControlLeft', {})
    await sleep(80)
    await kd(ms, 'Shift', 'ShiftLeft', { ctrl: true })
    await sleep(600)
    console.log('   panes:', await evaluate(ms, PANE_COUNT))
    await ku(ms, 'Shift', 'ShiftLeft', { ctrl: true })
    await ku(ms, 'Control', 'ControlLeft', {})

    console.log('\nengine log:')
    console.log(logs.join('\n') || '(none)')
    ms.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
