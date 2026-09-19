/**
 * Focus trace: open a webviewer pane, navigate, focus the page, split via
 * chord, and report where keyboard focus lands after each step.
 *
 *   node scripts/focusTrace.js
 * Pre: Tabby running with --remote-debugging-port=9231 and debug-cfg
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

async function click (s, x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
        await s.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
    }
}

/** Snapshot of both DOM focus and Electron-level focus. */
const FOCUS_STATE = `(() => {
    const ae = document.activeElement
    const r = require('@electron/remote')
    const f = r.getBuiltin('webContents').getFocusedWebContents()
    const views = r.getCurrentWindow().contentView.children.map(v => ({
        id: v.webContents.id, url: (v.webContents.getURL() || '').slice(0, 40),
    }))
    return JSON.stringify({
        domFocus: ae ? (ae.tagName + (ae.classList.contains('webviewer-address') ? '.webviewer-address' : '') + (ae.id ? '#' + ae.id : '')) : 'null',
        domFocusIsAddress: !!(ae && ae.classList && ae.classList.contains('webviewer-address')),
        domFocusInPane: (() => { const p = ae?.closest('webviewer-tab'); return p ? [...document.querySelectorAll('webviewer-tab')].indexOf(p) : -1 })(),
        paneCount: document.querySelectorAll('webviewer-tab').length,
        focusedWc: f ? f.id : null,
        focusedWcUrl: f ? (f.getURL() || '').slice(0, 40) : null,
        views,
    })
})()`

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) throw new Error('main window not found')
    const ms = await connect(main.webSocketDebuggerUrl)
    const consoleLines = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/webviewer-debug/.test(t)) consoleLines.push(`${Math.round(performance.now())}ms ${t.replace('%c', '').slice(0, 150)}`)
        } else if (m.method === 'Runtime.exceptionThrown') {
            consoleLines.push('[EXC] ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300))
        }
    })
    await ms.send('Runtime.enable')

    // dismiss first-run modal if present
    await sleep(2500)
    const modal = await evaluate(ms, `(() => {
        const b = document.querySelector('.modal-dialog .modal-footer button:last-child, .modal .btn:last-child')
        if (!b) return null
        b.click(); return b.textContent.trim()
    })()`)
    if (modal) console.log('first-run modal dismissed:', modal)
    await sleep(500)

    // open the profiles & connections panel (Ctrl+Shift+E = profile-selector)
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 })
    await sleep(60)
    await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'E', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: 10 })
    await sleep(100)
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'E', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: 10 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
    await sleep(1200)

    // open a Web viewer pane: click the "Web viewer" entry via DOM click
    const clicked = await evaluate(ms, `(() => {
        const snap = document.evaluate("//*[normalize-space(text())='Web viewer']", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
        for (let i = 0; i < snap.snapshotLength; i++) {
            const el = snap.snapshotItem(i)
            const r = el.getBoundingClientRect()
            if (r.width < 5 || r.height < 5) continue
            // climb to the clickable row
            let row = el
            for (let k = 0; k < 6 && row.parentElement; k++) {
                row = row.parentElement
                if (row.tagName === 'LI' || row.hasAttribute('ng-reflect-ng-class') || row.classList.contains('list-group-item')) break
            }
            row.click()
            return 'clicked ' + row.tagName
        }
        return 'not-found'
    })()`)
    console.log('entry click:', clicked)
    let opened = false
    for (let i = 0; i < 30; i++) {
        await sleep(300)
        if (await evaluate(ms, `!!document.querySelector('.webviewer-toolbar')`)) { opened = true; break }
    }
    console.log('webviewer pane opened:', opened)
    if (!opened) {
        console.log('console during open:\n' + consoleLines.slice(-20).join('\n'))
        throw new Error('webviewer pane did not open')
    }
    // the pane is URL-less → type into its (auto-focused) address bar
    await sleep(500)
    await ms.send('Input.insertText', { text: 'https://example.com' })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await sleep(1000)

    // wait for the page to load
    await sleep(5000)
    console.log('\n[after quick-connect open]', await evaluate(ms, FOCUS_STATE))

    // focus the page view like a user click would
    await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        r.getCurrentWindow().contentView.children.forEach(v => {
            if (v.webContents.getURL().startsWith('https')) v.webContents.focus()
        })
        return 'focused'
    })()`)
    await sleep(800)
    console.log('[after page focused]', await evaluate(ms, FOCUS_STATE))

    // send the split chord to the FOCUSED view (page has keyboard focus)
    const sendInput = ev => evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const f = r.getBuiltin('webContents').getFocusedWebContents()
        if (!f) return 'no-focused-wc'
        f.sendInputEvent(${JSON.stringify(ev)})
        return 'sent'
    })()`)
    console.log('\n=== sending Ctrl+Shift+D (split-right) to focused page ===')
    await sendInput({ type: 'keyDown', keyCode: 'Control' })
    await sleep(70)
    await sendInput({ type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sleep(70)
    await sendInput({ type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
    await sleep(130)
    await sendInput({ type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
    await sendInput({ type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sendInput({ type: 'keyUp', keyCode: 'Control' })

    await sleep(3000)
    console.log('[after split]', await evaluate(ms, FOCUS_STATE))

    // settle: wait longer and re-check — does the new pane KEEP keyboard focus?
    await sleep(4000)
    console.log('[after settle 7s]', await evaluate(ms, FOCUS_STATE))

    // type a character through the OS-focused wc — where does it land?
    await sendInput({ type: 'keyDown', keyCode: 'z' })
    await sleep(200)
    await sendInput({ type: 'keyUp', keyCode: 'z' })
    await sleep(500)
    console.log('[after typing z]', await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        return JSON.stringify({
            addrValues: panes.map(p => (p.querySelector('.webviewer-address') || {value: '?' || ''}).value),
            domFocus: document.activeElement?.tagName + '.' + String(document.activeElement?.className || '').split(' ')[0],
        })
    })()`))

    // pane-nav LEFT: focus should follow to pane A's page
    console.log('\n=== Ctrl+Alt+Left (pane-nav-left) ===')
    await sendInput({ type: 'keyDown', keyCode: 'Control' })
    await sleep(60)
    await sendInput({ type: 'keyDown', keyCode: 'Alt', modifiers: ['ctrl'] })
    await sleep(60)
    await sendInput({ type: 'keyDown', keyCode: 'Left', modifiers: ['ctrl', 'alt'] })
    await sleep(120)
    await sendInput({ type: 'keyUp', keyCode: 'Left', modifiers: ['ctrl', 'alt'] })
    await sendInput({ type: 'keyUp', keyCode: 'Alt', modifiers: ['ctrl'] })
    await sendInput({ type: 'keyUp', keyCode: 'Control' })
    await sleep(1500)
    console.log('[after pane-nav-left]', await evaluate(ms, FOCUS_STATE))

    // Ctrl+L → address bar of the focused pane (A); type z; Escape → back to page
    console.log('\n=== Ctrl+L on pane A ===')
    await sendInput({ type: 'keyDown', keyCode: 'Control' })
    await sleep(60)
    await sendInput({ type: 'keyDown', keyCode: 'l', modifiers: ['ctrl'] })
    await sleep(120)
    await sendInput({ type: 'keyUp', keyCode: 'l', modifiers: ['ctrl'] })
    await sendInput({ type: 'keyUp', keyCode: 'Control' })
    await sleep(600)
    console.log('[after Ctrl+L]', await evaluate(ms, FOCUS_STATE))
    await sendInput({ type: 'keyDown', keyCode: 'z' })
    await sleep(150)
    await sendInput({ type: 'keyUp', keyCode: 'z' })
    await sleep(300)
    await sendInput({ type: 'keyDown', keyCode: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(150)
    await sendInput({ type: 'keyUp', keyCode: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(600)
    console.log('[after typing z + Escape]', await evaluate(ms, FOCUS_STATE))
    console.log('[addr values]', await evaluate(ms, `[...document.querySelectorAll('webviewer-tab .webviewer-address')].map(i => i.value)`))

    // modal: command palette (Ctrl+Shift+P) opens → occlusion dock steals to DOM;
    // close it → focus should come back to pane A's page
    console.log('\n=== Ctrl+Shift+P palette open/close ===')
    await sendInput({ type: 'keyDown', keyCode: 'Control' })
    await sleep(60)
    await sendInput({ type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sleep(60)
    await sendInput({ type: 'keyDown', keyCode: 'p', modifiers: ['ctrl', 'shift'] })
    await sleep(150)
    await sendInput({ type: 'keyUp', keyCode: 'p', modifiers: ['ctrl', 'shift'] })
    await sendInput({ type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sendInput({ type: 'keyUp', keyCode: 'Control' })
    await sleep(1500)
    console.log('[palette open]', await evaluate(ms, FOCUS_STATE))
    await sendInput({ type: 'keyDown', keyCode: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(150)
    await sendInput({ type: 'keyUp', keyCode: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(1500)
    console.log('[palette closed]', await evaluate(ms, FOCUS_STATE))

    console.log('\n--- debug log (split window) ---')
    console.log(consoleLines.slice(-50).join('\n') || '(none)')
    ms.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
