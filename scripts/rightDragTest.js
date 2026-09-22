/** Right-layout drag: the left-edge handle drags LEFT to grow; the pointer
 *  crosses onto the native view, so the gesture dock must keep the drag
 *  alive. Pre: right layout, a recorder drawer open on the visible pane. */
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

async function main () {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.find(x => x.type === 'page' && x.url.includes('index'))
    const ms = await connect(t.webSocketDebuggerUrl)

    const state = async () => evaluate(ms, `(() => {
        const vis = [...document.querySelectorAll('webviewer-tab')].find(p => p.getBoundingClientRect().x > -100)
        if (!vis) return null
        const host = vis.querySelector('webviewer-recorder-panel')
        const h = vis.querySelector('.recorder-resize')?.getBoundingClientRect()
        const content = vis.querySelector('.webviewer-content')
        return { hx: h.x + 2, hy: h.y + h.height / 2,
                 w: Math.round(host?.getBoundingClientRect().width ?? 0),
                 contentW: Math.round(content.getBoundingClientRect().width),
                 paneW: Math.round(vis.querySelector('.webviewer-root').getBoundingClientRect().width) }
    })()`)
    let before = await state()
    if (!before || !before.hx) throw new Error('no right drawer — run recorderShot.js first: ' + JSON.stringify(before))
    console.log('before:', JSON.stringify(before))

    const Y = before.hy
    let X = before.hx
    // If the drawer already sits at the growth clamp, drag RIGHT (shrink);
    // otherwise drag LEFT (grow). Either way the resize axis + gesture dock
    // are exercised.
    const atClamp = before.w >= before.paneW - 145
    const dir = atClamp ? 1 : -1
    await ms.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y, button: 'none', pointerType: 'mouse' })
    await ms.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    for (let i = 1; i <= 12; i++) {
        X = before.hx + dir * i * 10
        await ms.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y, button: 'left', buttons: 1, pointerType: 'mouse' })
        await sleep(16)
    }
    await ms.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await sleep(500)

    const after = await state()
    console.log('after: ', JSON.stringify(after), `(dragged ${atClamp ? 'right/shrink' : 'left/grow'}, clamp ${after.paneW - 140})`)
    // shrink floors at 200px, growth caps at paneW - 140
    const expected = atClamp ? Math.max(200, before.w - 120) : Math.min(before.w + 120, after.paneW - 140)
    const ok = Math.abs(after.w - expected) <= 3
    console.log(ok ? `PASS  right drawer resized by drag (${before.w} → ${after.w}, expected ${expected})`
        : `FAIL  width ${before.w} → ${after.w} (expected ~${expected})`)
    ms.close()
    process.exitCode = ok ? 0 : 1
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
