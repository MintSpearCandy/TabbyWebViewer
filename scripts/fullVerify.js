/** Full E2E verification: open pane, navigate, split via chord, nav via chord. */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9233

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
        throw new Error(String((inner.exceptionDetails.exception || {}).description || '').slice(0, 250))
    }
    return inner.result ? inner.result.value : undefined
}

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) {
        throw new Error('main window not found')
    }
    const ms = await connect(main.webSocketDebuggerUrl)
    const logs = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/webviewer-debug|hotkey|HOTKEY/i.test(t)) logs.push(t.slice(0, 130))
        }
    })
    await ms.send('Runtime.enable')

    // 1. open the palette, then profiles panel, then Web viewer
    await evaluate(ms, `
        (() => {
            const press = (k, c, vk, mods) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: c, keyCode: vk, ctrlKey: !!(mods&2), shiftKey: !!(mods&8), bubbles: true }))
            return 'noop'
        })()`)
    // open palette via real key events
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 })
    await sleep(60)
    await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 })
    await sleep(100)
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'P', code: 'KeyP', windowsVirtualKeyCode: 80, modifiers: 10 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
    await sleep(900)
    console.log('palette→profiles:', await evaluate(ms, `(() => {
        const els = [...document.querySelectorAll('.modal.show *, .modal *')].filter(x => x.children.length === 0 && (x.textContent || '').trim() === '配置和连接')
        if (!els.length) { return 'PALLETTE ENTRY NOT FOUND' }
        els[0].click(); return 'clicked'
    })()`))
    await sleep(1000)
    console.log('panel→webviewer:', await evaluate(ms, `(() => {
        const els = [...document.querySelectorAll('*')].filter(x => x.children.length === 0 && (x.textContent || '').trim() === 'Web viewer')
        if (!els.length) { return 'NOT FOUND' }
        els[0].click(); return 'clicked'
    })()`))
    await sleep(1500)
    console.log('pane open:', await evaluate(ms, `!!document.querySelector('.webviewer-toolbar')`))

    // 2. type URL (address bar autofocused in main DOM)
    await ms.send('Input.insertText', { text: 'https://example.com' })
    await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await sleep(5000)

    // 3. focus the page via remote
    await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        ;(r.getCurrentWindow().contentView.children || []).forEach(v => {
            if (v.webContents.getURL().startsWith('https')) v.webContents.focus()
        })
        return 'focused'
    })()`)
    await sleep(800)

    // sendInputEvent helper — ONLY to the currently FOCUSED https view
    const sendInput = ev => evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const focused = r.getBuiltin('webContents').getFocusedWebContents()
        if (!focused || !focused.getURL().startsWith('https')) { return 'no-focused-view' }
        focused.sendInputEvent(${JSON.stringify(ev)})
        return 'sent'
    })()`)

    logs.length = 0
    console.log('\n=== Ctrl+Shift+D (split-right) ===')
    await sendInput({ type: 'keyDown', keyCode: 'Control' })
    await sleep(70)
    await sendInput({ type: 'keyDown', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sleep(70)
    await sendInput({ type: 'keyDown', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
    await sleep(130)
    await sendInput({ type: 'keyUp', keyCode: 'd', modifiers: ['ctrl', 'shift'] })
    await sendInput({ type: 'keyUp', keyCode: 'Shift', modifiers: ['ctrl'] })
    await sendInput({ type: 'keyUp', keyCode: 'Control' })
    await sleep(2500)
    console.log('PANES:', await evaluate(ms, `document.querySelectorAll('.webviewer-toolbar').length`))
    console.log(logs.filter(l => /HOTKEY|Matched|split/.test(l) || l.includes('fwd keyDown')).join('\n'))

    // 4. pane-nav: from the focused pane, Ctrl+Alt+Left (to the left pane)
    logs.length = 0
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
    console.log(logs.filter(l => /pane-nav|Matched|pane focused|pane blurred|handover/.test(l)).join('\n') || '(no relevant logs)')

    // final keyboard ownership
    console.log('\nfinal keyboard:', await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const f = r.getBuiltin('webContents').getFocusedWebContents()
        return JSON.stringify({ focusedId: f ? f.id : null, views: (r.getCurrentWindow().contentView.children || []).map(v => v.webContents.id) })
    })()`))
    ms.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
