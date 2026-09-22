/** Reproduce the poisoned state (pane nav + blur) then try recovery variants.
 *  keydump v2 logs capture AND bubble arrival + event target, distinguishing
 *  "event stopped below document" from "engine listener silent". */
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
            if (/hotkey|keydump|recovery/.test(text)) log.push('    ' + text)
        }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value
    await send('Runtime.enable')

    await evaluate(`(() => {
        if (window.__keydump2) return
        window.__keydump2 = true
        for (const t of ['keydown', 'keyup']) {
            document.addEventListener(t, e => console.debug('[keydump-CAP]', t, e.key, 'target=' + e.target.tagName), true)
            document.addEventListener(t, e => console.debug('[keydump-BUB]', t, e.key, 'target=' + e.target.tagName), false)
        }
    })()`)

    const tabChord = async () => {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await new Promise(r => setTimeout(r, 900))
    }
    const realOrderChord = async () => {
        // modifier-first: press Ctrl, then Tab, release Tab, release Ctrl
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17 })
        await new Promise(r => setTimeout(r, 900))
    }
    const ae = () => evaluate(`(document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : 'none').slice(0, 60)`)

    // reproduce poison: nav + settle + blur
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

    log.push('=== R0 poisoned state, single-shot chord ===')
    log.push(`    activeElement: ${await ae()}`)
    await tabChord()

    log.push('=== R1 immediate retry ===')
    await tabChord()

    log.push('=== R2 document.body.focus() then chord ===')
    await evaluate(`document.body.focus()`)
    log.push(`    activeElement: ${await ae()}`)
    await tabChord()

    log.push('=== R3 modifier-first realistic order ===')
    await realOrderChord()

    console.log(log.join('\n'))
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
