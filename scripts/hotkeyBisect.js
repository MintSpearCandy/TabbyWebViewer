/** Bisect which CDP key-injection pattern the Tabby hotkey engine actually
 *  responds to. Engine logs (Matched/Unmatched hotkey) are captured live via
 *  Runtime.consoleAPICalled and interleaved with per-pattern markers. */
const PORT = process.env.CDP_PORT || 9231

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    const log = []        // ordered stream: markers + engine logs
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/hotkey|probe/.test(text)) log.push('    engine: ' + text)
        }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value
    await send('Runtime.enable')

    const activeIdx = () => evaluate(`[...document.querySelectorAll('tab-header')].findIndex(h => h.classList.contains('active'))`)
    const key = (type, modifiers, keyName, code, vk) => send('Input.dispatchKeyEvent', {
        type, modifiers, key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
    const sleep = ms => new Promise(r => setTimeout(r, ms))

    const patterns = [
        ['Ctrl-Tab  rawDown(m2)+keyUp(m0)', async () => {
            await key('rawKeyDown', 2, 'Tab', 'Tab', 9); await key('keyUp', 0, 'Tab', 'Tab', 9)
        }],
        ['Ctrl-Tab  rawDown(m2)+keyUp(m2)', async () => {
            await key('rawKeyDown', 2, 'Tab', 'Tab', 9); await key('keyUp', 2, 'Tab', 'Tab', 9)
        }],
        ['Ctrl-Tab  char event variant', async () => {
            await key('keyDown', 2, 'Tab', 'Tab', 9); await key('keyUp', 0, 'Tab', 'Tab', 9)
        }],
        ['Ctrl-Shift-Tab  rawDown(m10)+keyUp(m0) [known good]', async () => {
            await key('rawKeyDown', 10, 'Tab', 'Tab', 9); await key('keyUp', 0, 'Tab', 'Tab', 9)
        }],
        ['Ctrl-Shift-Right  rawDown(m10)+keyUp(m0)', async () => {
            await key('rawKeyDown', 10, 'ArrowRight', 'ArrowRight', 39); await key('keyUp', 0, 'ArrowRight', 'ArrowRight', 39)
        }],
    ]

    for (const [name, fire] of patterns) {
        const before = await activeIdx()
        await evaluate(`console.log('[probe] >>> ${name}')`)
        log.push(`>>> ${name}   (active header ${before})`)
        await fire()
        await sleep(700)
        const after = await activeIdx()
        log.push(`    active header ${before} -> ${after} ${after !== before ? '(SWITCHED)' : '(no change)'}`)
        await sleep(250)
    }
    console.log(log.join('\n'))
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
