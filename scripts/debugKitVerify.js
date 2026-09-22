/** End-to-end verification of the tabby-debug skill's forensic recipes:
 *  CDP attach, renderer console + exception capture, focus state, ngModel pane
 *  navigation + unique-URL target selection, CDP key injection (hotkey engine),
 *  screenshot, and Tabby's own log.txt channel. Run against the 9231 instance. */
const fs = require('fs')
const path = require('path')

const PORT = process.env.CDP_PORT || 9231
const RUN = Date.now()
const events = []          // every console/exception event captured this run
let pass = 0, fail = 0
const check = (ok, label, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
    ok ? pass++ : fail++
}

async function main () {
    // --- connect (event-capable boilerplate, per skill §3) ---
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) throw new Error('main window target not found')
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    const listeners = []
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return }
        for (const fn of listeners) fn(m)
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value
    check(true, 'CDP attach to main window', main.url.slice(0, 50))

    // --- renderer console + exception capture (skill §3: Runtime.enable + events) ---
    await send('Runtime.enable')
    listeners.push(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            events.push({ t: Date.now(), kind: 'console.' + m.params.type,
                text: m.params.args.map(a => a.value ?? a.description ?? a.type).join(' ') })
        } else if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails
            events.push({ t: Date.now(), kind: 'exception', text: (d.exception?.description || d.text || '').split('\n')[0] })
        }
    })
    await evaluate(`console.log('[debugkit-verify] log-marker ${RUN}'); console.warn('[debugkit-verify] warn-marker ${RUN}')`)
    await evaluate(`setTimeout(() => { throw new Error('[debugkit-verify] exception-marker ${RUN}') }, 0)`)
    await new Promise(r => setTimeout(r, 1200))
    check(events.some(e => e.kind === 'console.log' && e.text.includes('log-marker')),
        'console.log captured via Runtime.consoleAPICalled')
    check(events.some(e => e.kind === 'console.warning' && e.text.includes('warn-marker')),
        'console.warn captured')
    check(events.some(e => e.kind === 'exception' && e.text.includes('exception-marker')),
        'uncaught exception captured via Runtime.exceptionThrown')

    // --- focus forensics (FOCUS_STATE pattern from focusTrace.js) ---
    const focus = await evaluate(`(() => {
        const r = require('@electron/remote')
        const wc = r.getBuiltin('webContents').getFocusedWebContents()
        const ae = document.activeElement
        const views = r.getCurrentWindow().contentView.children.map(v => v.webContents.getURL().slice(0, 50))
        return JSON.stringify({
            domFocus: ae ? (ae.tagName + '.' + (ae.className || '')).slice(0, 60) : null,
            domFocusInPane: !!ae.closest('webviewer-tab'),
            focusedWc: wc ? wc.getURL().slice(0, 50) : null,
            viewCount: views.length, views,
        })
    })()`)
    const f = JSON.parse(focus)
    check(f.viewCount !== undefined && f.domFocus !== undefined, 'focus state (DOM + Electron webContents)',
        `views=${f.viewCount} focusedWc=${f.focusedWc || 'null'} domFocus=${f.domFocus}`)

    // --- ngModel pane navigation + unique-URL target selection (skill §3) ---
    const navOk = await evaluate(`(() => {
        const el = document.querySelector('webviewer-tab .webviewer-address')
        if (!el) return false
        el.value = 'example.com/?run${RUN}'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return true
    })()`)
    let paneTarget = null
    if (navOk) {
        for (let i = 0; i < 20 && !paneTarget; i++) {
            await new Promise(r => setTimeout(r, 700))
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
            paneTarget = list.find(t => t.url.includes(`run${RUN}`))
        }
    }
    check(!!paneTarget, 'ngModel navigate pane + select target by unique run marker',
        paneTarget ? paneTarget.url : (navOk ? 'no matching target after 14s' : 'no webviewer pane restored'))
    // Navigation hands keyboard ownership to the page view (claimKeyboardFocus);
    // main-window hotkey injection no-ops until focus settles — wait it out.
    await new Promise(r => setTimeout(r, 1200))

    // --- CDP key injection end-to-end: Ctrl-Tab moves the active tab-header ---
    const activeIdx = () => evaluate(`[...document.querySelectorAll('tab-header')].findIndex(h => h.classList.contains('active'))`)
    const headers = await evaluate(`document.querySelectorAll('tab-header').length`)
    // An xterm helper textarea holding DOM focus (even in a NON-active tab) eats
    // chord keys xterm treats as terminal sequences (Ctrl-Tab) before they reach
    // the hotkey engine — blur it first or the injection silently no-ops.
    await evaluate(`document.activeElement && document.activeElement !== document.body ? document.activeElement.blur() : 0`)
    // First CDP chord right after a pane navigation is silently dropped by the
    // engine's timeStamp dedup (hotkeys.service pushKeyEvent: a focus-handover
    // synthetic push owns the same stamp). Burn the slot with an unbound dummy
    // key (F13) so the real chord lands.
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
    await new Promise(r => setTimeout(r, 300))
    if (headers < 2) {
        console.log('SKIP key injection — only ' + headers + ' tab(s) restored')
    } else {
        const before = await activeIdx()
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await new Promise(r => setTimeout(r, 600))
        const after = await activeIdx()
        check(after !== before && after >= 0, 'CDP Input.dispatchKeyEvent drives hotkey engine (Ctrl-Tab)',
            `active header ${before} → ${after} of ${headers}`)
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 10, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
        await new Promise(r => setTimeout(r, 600))
        const restored = await activeIdx()
        check(restored === before, 'Ctrl-Shift-Tab restores selection', `${restored} === ${before}`)
        check(events.some(e => /Matched hotkey|Unmatched hotkey/.test(e.text)),
            'hotkey engine logs captured live (Runtime.consoleAPICalled)')
    }

    // --- screenshot (full window) ---
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const out = path.resolve(__dirname, '..', 'test-env', 'debugkit-shot.png')
    fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))
    check(fs.statSync(out).size > 10000, 'Page.captureScreenshot saved', `${out} (${fs.statSync(out).size} bytes)`)

    ws.close()

    // --- Tabby's own log channel (main-process / node side) ---
    const logPath = path.resolve(__dirname, '..', 'test-env', 'tabby-port', 'data', 'log.txt')
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n')
    const recent = lines.filter(l => l.includes(`run${RUN}`) || l.includes('remote-debugging-port')).slice(-3)
    check(lines.length > 0, 'Tabby log.txt readable', `${lines.length} lines at data/log.txt`)
    if (recent.length) console.log('log.txt tail sample:\n  ' + recent.join('\n  '))

    // --- natural renderer logs observed during the run (excl. our markers) ---
    const natural = events.filter(e => !e.text.includes('debugkit-verify'))
    console.log(`\nnatural renderer console events this run: ${natural.length}`)
    for (const e of natural.slice(0, 15)) console.log(`  [${e.kind}] ${e.text.slice(0, 110)}`)

    console.log(fail ? `\n${fail} CHECK(S) FAILED` : '\nALL CHECKS PASSED')
    process.exitCode = fail ? 1 : 0
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
