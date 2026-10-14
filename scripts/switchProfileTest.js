/** Regression: switch-profile (replaceTab) must leave the swapped-in
 *  webviewer pane RENDERED. Tabby's SplitTabComponent.replaceTab never emits
 *  visibility to the new tab; before the fix the pane's native view stayed
 *  hidden (0×0 bounds) until the user switched top-level tabs away and back.
 *
 *  Prereqs (wv instance config, restart after changing):
 *    - hotkeys: switch-profile: [Ctrl-F9]   (Alt-combos are CDP-inject-dead)
 *    - showProfileTree: true + a saved webviewer profile "WV Panel Test"
 *      (id + url https://example.com) — see scripts/addWvTestProfile.js
 *    - a split tab present (any restored split works; the script activates
 *      the first tab-body containing a split-tab-spanner)
 *  Flow: activate split → focus a pane → Ctrl-F9 (F13 sacrifice, 2 rounds)
 *    → click the "WV Panel Test" option in the selector modal → assert the
 *    on-screen pane's host rect has a matching native view (geometry match).
 */
const PORT = process.env.CDP_PORT || 9232
const sleep = ms => new Promise(r => setTimeout(r, ms))
let failed = 0
const check = (ok, label, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' — ' + extra : ''}`)
    ok || failed++
}

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) { throw new Error('main window target not found') }
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value

    // 1. activate a split tab and focus one of its panes
    const prep = await evaluate(`(() => {
        const bodies = [...document.querySelectorAll('tab-body')]
        const i = bodies.findIndex(b => b.querySelector('split-tab-spanner'))
        if (i < 0) return 'no-split'
        ;[...document.querySelectorAll('tab-header')][i]?.click()
        const labels = document.querySelectorAll('split-tab-pane-label')
        if (labels[0]) { labels[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) }
        return 'ok'
    })()`)
    check(prep === 'ok', 'split tab activated, pane focused', prep)
    if (prep !== 'ok') { throw new Error('need a split tab in the session') }
    await sleep(900)

    // 2. switch-profile hotkey (blur + F13 sacrifice + two rounds)
    await evaluate(`document.activeElement && document.activeElement !== document.body ? document.activeElement.blur() : 0`)
    for (const type of ['rawKeyDown', 'keyUp']) {
        await send('Input.dispatchKeyEvent', { type, key: 'F13', code: 'F13', windowsVirtualKeyCode: 124, nativeVirtualKeyCode: 124 })
    }
    for (let round = 0; round < 2; round++) {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers: 2, key: 'F9', code: 'F9', windowsVirtualKeyCode: 120, nativeVirtualKeyCode: 120 })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'F9', code: 'F9', windowsVirtualKeyCode: 120, nativeVirtualKeyCode: 120 })
        await sleep(350)
    }
    await sleep(700)
    const modalOpen = await evaluate(`!!document.querySelector('ngb-modal-window, selector-modal, app-selector-modal')`)
    check(modalOpen, 'selector modal opened by Ctrl-F9')
    if (!modalOpen) { throw new Error('selector modal did not open — check the switch-profile: Ctrl-F9 binding and restart') }

    // 3. pick the webviewer profile in the modal
    const picked = await evaluate(`(() => {
        const modal = document.querySelector('ngb-modal-window, selector-modal, app-selector-modal')
        const opts = [...modal.querySelectorAll('*')].filter(e => e.children.length === 0 && /WV Panel Test/.test(e.textContent || ''))
        if (!opts.length) return 'no-option'
        opts[opts.length - 1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return 'ok'
    })()`)
    check(picked === 'ok', 'webviewer profile picked in the selector', picked)
    if (picked !== 'ok') { throw new Error('profile option not found — run scripts/addWvTestProfile.js and restart') }
    await sleep(6000)

    // 4. the swapped-in pane must be rendered: its on-screen host rect must
    //    have a native view glued to it (geometry match, zoom-aware)
    const state = JSON.parse(await evaluate(`(() => {
        const r = require('@electron/remote')
        const win = r.getCurrentWindow()
        const f = win.webContents.getZoomFactor()
        const host = [...document.querySelectorAll('webviewer-tab')]
            .map(t => t.querySelector('.webviewer-content'))
            .find(c => { const b = c.getBoundingClientRect(); return b.x > -100 && b.width > 50 })
        if (!host) return JSON.stringify({ err: 'no-onscreen-pane' })
        const hb = host.getBoundingClientRect()
        const views = win.contentView.children.map(v => {
            const b = v.getBounds()
            return { url: (v.webContents.getURL() || '').slice(0, 40), b: [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] }
        })
        return JSON.stringify({ host: [Math.round(hb.x), Math.round(hb.y), Math.round(hb.width), Math.round(hb.height)], f, views })
    })()`))
    if (state.err) { throw new Error(state.err) }
    const match = state.views.find(v => v.b[2] > 50
        && Math.abs(v.b[0] - state.host[0] * state.f) < 15
        && Math.abs(v.b[1] - state.host[1] * state.f) < 15
        && Math.abs(v.b[2] - state.host[2] * state.f) < 30)
    check(!!match, 'swapped-in pane has its native view glued on screen',
        `host=${state.host} zoom=${state.f}` + (match ? ` view=${match.b} (${match.url})` : ' — NO matching view'))

    // 5. page actually loaded in that view (not about:blank)
    check(!!match && match.url.includes('example.com'), 'swapped-in view navigated to the profile URL', match ? match.url : '')

    ws.close()
    console.log(failed ? `${failed} CHECK(S) FAILED` : 'ALL CHECKS PASSED')
    process.exitCode = failed ? 1 : 0
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
