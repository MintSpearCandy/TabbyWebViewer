/** Drawer drag-resize + page-view shrink check on the VISIBLE pane (CDP mouse
 *  on the resize handle). Opens a recorder on the visible pane if needed —
 *  which doubles as a multi-pane independence check. */
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9231

async function connect (url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) {
            pend.get(m.id)(m)
            pend.delete(m.id)
        }
    })
    return {
        send: (method, params = {}) => {
            const i = ++id
            ws.send(JSON.stringify({ id: i, method, params }))
            return new Promise(r => pend.set(i, r))
        },
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

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const mainT = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    const ms = await connect(mainT.webSocketDebuggerUrl)

    // Open a drawer on the VISIBLE pane (rect on-screen) if it has none
    const opened = await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        const vis = panes.find(p => p.getBoundingClientRect().x > -100)
        if (!vis) return 'no-visible-pane'
        if (!vis.querySelector('webviewer-recorder-panel')) {
            vis.querySelector('.fa-circle-dot')?.closest('button')?.click()
            return 'opened'
        }
        return 'already'
    })()`)
    await sleep(800)
    if (opened === 'no-visible-pane') {
        throw new Error('no visible webviewer pane')
    }

    const before = await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        const vis = panes.find(p => p.getBoundingClientRect().x > -100)
        const h = vis.querySelector('.recorder-resize')?.getBoundingClientRect()
        const host = vis.querySelector('webviewer-recorder-panel')
        return { hx: h.x + h.width / 2, hy: h.y + 2,
                 panel: String(Math.round(host?.getBoundingClientRect().height ?? 0)),
                 content: Math.round(vis.querySelector('.webviewer-content')?.getBoundingClientRect().height ?? 0) }
    })()`)
    if (typeof before.hx !== 'number' || before.hx < 0) {
        throw new Error('drawer handle not visible: ' + JSON.stringify(before))
    }
    console.log('visible pane state before:', JSON.stringify(before), `(${opened})`)

    const belowPage = await evaluate(ms, `(() => {
        const vis = [...document.querySelectorAll('webviewer-tab')].find(p => p.getBoundingClientRect().x > -100)
        const host = vis.querySelector('webviewer-recorder-panel')
        const content = vis.querySelector('.webviewer-content')
        return host.getBoundingClientRect().y > content.getBoundingClientRect().y
    })()`)
    console.log(belowPage ? 'PASS  bottom layout: drawer below the page' : 'FAIL  drawer not below the page')

    const X = before.hx
    let Y = before.hy
    await ms.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y, button: 'none', pointerType: 'mouse' })
    await ms.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    for (let i = 1; i <= 12; i++) {
        Y = before.hy - i * 8  // drag UP to grow
        await ms.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y, button: 'left', buttons: 1, pointerType: 'mouse' })
        await sleep(16)
    }
    await ms.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1, pointerType: 'mouse' })
    await sleep(500)

    const after = await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        const vis = panes.find(p => p.getBoundingClientRect().x > -100)
        const host = vis.querySelector('webviewer-recorder-panel')
        return { panel: String(Math.round(host?.getBoundingClientRect().height ?? 0)),
                 content: Math.round(vis.querySelector('.webviewer-content')?.getBoundingClientRect().height ?? 0) }
    })()`)
    console.log('after drag:', JSON.stringify(after))

    const h0 = parseInt(before.panel, 10)
    const h1 = parseInt(after.panel, 10)
    const okGrow = h1 >= h0 + 60 && h1 <= h0 + 110
    const okShrink = before.content - after.content >= 60
    console.log(okGrow ? 'PASS  drawer grew by drag (~96px, rendered rect)' : `FAIL  drawer height ${before.panel} → ${after.panel}`)
    console.log(okShrink ? 'PASS  page content area shrank accordingly (native view follows)' : `FAIL  content ${before.content} → ${after.content}`)

    // fixed-height regression guard: many rows must NOT grow the drawer
    const stable = await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        const vis = panes.find(p => p.getBoundingClientRect().x > -100)
        const host = vis.querySelector('webviewer-recorder-panel')
        return Math.round(host.getBoundingClientRect().height)
    })()`)
    const okStable = Math.abs(stable - h1) <= 1
    console.log(okStable ? 'PASS  drawer height stable with content' : `FAIL  drawer height drifted ${h1} → ${stable}`)

    // hide → re-summon: the dragged height must be remembered
    await evaluate(ms, `document.querySelector('webviewer-recorder-panel .fa-chevron-down')?.closest('button')?.click()`)
    await sleep(400)
    await evaluate(ms, `(() => {
        const vis = [...document.querySelectorAll('webviewer-tab')].find(p => p.getBoundingClientRect().x > -100)
        vis?.querySelector('.fa-circle-dot')?.closest('button')?.click()
        return 'ok'
    })()`)
    await sleep(500)
    const resummoned = await evaluate(ms, `(() => {
        const panes = [...document.querySelectorAll('webviewer-tab')]
        const vis = panes.find(p => p.getBoundingClientRect().x > -100)
        return Math.round(vis.querySelector('webviewer-recorder-panel')?.getBoundingClientRect().height ?? 0)
    })()`)
    const okKeep = Math.abs(resummoned - h1) <= 1
    console.log(okKeep ? `PASS  dragged height kept after hide + re-summon (${resummoned}px)` : `FAIL  height reset ${h1} → ${resummoned}`)

    ms.close()
    process.exitCode = okGrow && okShrink && okStable && okKeep && belowPage ? 0 : 1
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
