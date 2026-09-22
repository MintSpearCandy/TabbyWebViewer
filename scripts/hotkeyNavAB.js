/** A/B probe: do injected chords behave differently before vs after a webviewer
 *  pane navigation? A capture-phase keydump on document shows exactly what the
 *  main window DOM received; engine Matched/Unmatched logs show what the hotkey
 *  engine did with it. */
const PORT = process.env.CDP_PORT || 9231
const RUN = Date.now()

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
            if (/hotkey|keydump|probe/.test(text)) log.push('    ' + text)
        }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value
    await send('Runtime.enable')

    // capture-phase keydump: everything the main window DOM receives
    await evaluate(`(() => {
        if (window.__keydump) return
        window.__keydump = true
        for (const t of ['keydown', 'keyup']) {
            document.addEventListener(t, e => {
                console.debug('[keydump]', t, 'key=' + e.key, 'ctrl=' + e.ctrlKey, 'shift=' + e.shiftKey, 'ts=' + e.timeStamp.toFixed(1))
            }, true)
        }
    })()`)

    const key = (type, modifiers, keyName, vk) => send('Input.dispatchKeyEvent', {
        type, modifiers, key: keyName, code: keyName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    const chord = async (label, m) => {
        await evaluate(`console.log('[probe] chord ${label}')`)
        await key('rawKeyDown', m, 'Tab', 9)
        await key('keyUp', 0, 'Tab', 9)
        await new Promise(r => setTimeout(r, 800))
    }
    const activeIdx = () => evaluate(`[...document.querySelectorAll('tab-header')].findIndex(h => h.classList.contains('active'))`)

    log.push('=== PHASE A (before any navigation this session) ===')
    log.push(`active header: ${await activeIdx()}`)
    await chord('A1 Ctrl-Tab m2', 2)
    log.push(`active header: ${await activeIdx()}`)
    await chord('A2 Ctrl-Shift-Tab m10', 10)
    log.push(`active header: ${await activeIdx()}`)

    log.push('=== NAVIGATE webviewer pane ===')
    await evaluate(`(() => {
        const el = document.querySelector('webviewer-tab .webviewer-address')
        el.value = 'example.com/?run${RUN}'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })()`)
    for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 700))
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
        if (list.some(t => t.url.includes(`run${RUN}`))) break
    }
    await new Promise(r => setTimeout(r, 1500))

    log.push('=== PHASE B (after pane navigation) ===')
    log.push(`active header: ${await activeIdx()}`)
    await chord('B1 Ctrl-Tab m2', 2)
    log.push(`active header: ${await activeIdx()}`)
    await chord('B2 Ctrl-Shift-Tab m10', 10)
    log.push(`active header: ${await activeIdx()}`)

    console.log(log.join('\n'))
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
