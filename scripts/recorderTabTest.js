/** Detached-tab layout E2E: close tab while recording keeps the session,
 *  the pane's record button re-opens it, closing while stopped releases.
 *  Pre: tab layout configured, a pane recording with a live recorder-tab
 *  (run recorderShot.js first). */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9231

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
        send: (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) }),
        close: () => ws.close(),
    }
}

async function evaluate (s, expression) {
    const r = await s.send('Runtime.evaluate', { expression, returnByValue: true })
    const inner = r.result || {}
    if (inner.exceptionDetails) throw new Error(String((inner.exceptionDetails.exception || {}).description || '').slice(0, 300))
    return inner.result ? inner.result.value : undefined
}

let failed = 0
function check (label, ok, extra = '') {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : ` — ${extra}`}`)
    if (!ok) { failed++ }
}

const STATE = `(() => {
    const panes = [...document.querySelectorAll('webviewer-tab')]
    const recorded = panes.find(p => !!p.querySelector('.recording-active')) || null
    return JSON.stringify({
        tabCount: document.querySelectorAll('recorder-tab').length,
        pulse: panes.some(p => !!p.querySelector('.recording-active')),
        recordedIndex: recorded ? panes.indexOf(recorded) : -1,
        bannerInTab: !!document.querySelector('recorder-tab .recorder-banner'),
    })
})()`

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.find(x => x.type === 'page' && x.url.includes('index'))
    const ms = await connect(t.webSocketDebuggerUrl)

    let st = JSON.parse(await evaluate(ms, STATE))
    check('pre: recording with detached tab open', st.pulse && st.tabCount === 1, JSON.stringify(st))
    const paneIdx = st.recordedIndex

    // 1. close the recorder tab while recording (Ctrl+W on the ACTIVE tab) --
    const closed = await evaluate(ms, `(() => {
        const hdrs = [...document.querySelectorAll('tab-header')]
        const hdr = hdrs.find(h => (h.textContent || '').includes('Recorder'))
        if (!hdr) return 'no-header'
        if (!hdr.classList.contains('active')) {
            hdr.querySelector('.name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        return 'ok'
    })()`)
    await sleep(400)
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'W', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 10 })
    await sleep(120)
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'W', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 10 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
    await sleep(600)
    st = JSON.parse(await evaluate(ms, STATE))
    check('tab closed while recording', closed === 'ok' && st.tabCount === 0, `${closed} / ${JSON.stringify(st)}`)
    check('recording survives tab close', st.pulse)

    // 2. record button re-summons the tab -------------------------------------
    await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        panes[${paneIdx}]?.querySelector('.fa-circle-dot')?.closest('button')?.click()
        return 'ok'
    })()`)
    await sleep(700)
    st = JSON.parse(await evaluate(ms, STATE))
    check('record click re-opens the detached tab', st.tabCount === 1, JSON.stringify(st))
    check('still recording after re-open (no banner)', st.pulse && !st.bannerInTab)

    // 3. stop via the pane button (tab open → toggles) ------------------------
    await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        panes[${paneIdx}]?.querySelector('.fa-circle-dot')?.closest('button')?.click()
        return 'ok'
    })()`)
    await sleep(600)
    st = JSON.parse(await evaluate(ms, STATE))
    check('second click stops recording (banner in tab)', !st.pulse && st.bannerInTab, JSON.stringify(st))

    // 4. close the tab while STOPPED → recorder released (Ctrl+W) ------------
    await evaluate(ms, `(() => {
        const hdrs = [...document.querySelectorAll('tab-header')]
        const hdr = hdrs.find(h => (h.textContent || '').includes('Recorder'))
        if (hdr && !hdr.classList.contains('active')) {
            hdr.querySelector('.name')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        }
        return 'ok'
    })()`)
    await sleep(400)
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'W', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 10 })
    await sleep(120)
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'W', code: 'KeyW', windowsVirtualKeyCode: 87, modifiers: 10 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
    await sleep(600)
    st = JSON.parse(await evaluate(ms, STATE))
    check('stop + close releases the session', st.tabCount === 0 && !st.pulse, JSON.stringify(st))

    console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
    ms.close()
    process.exitCode = failed === 0 ? 0 : 1
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
