/** Diagnose: a REAL sweep (CDP Input.dispatchMouseEvent — Chromium's actual
 *  input pipeline, so mouseenter dispatch and the common-ancestor click rule
 *  behave exactly as for a physical mouse) dismisses the multi-selection at
 *  gesture END. Capture the panel's [wv-sel] debug logs to identify the
 *  clearer. Prereq: recorderShot.js ran (drawer open, ≥4 console rows). */
const PORT = process.env.CDP_PORT || 9231
const sleep = ms => new Promise(r => setTimeout(r, ms))

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
            if (text.includes('[wv-sel]')) log.push(text)
        }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evaluate = async ex => (await send('Runtime.evaluate', { expression: ex, returnByValue: true })).result?.result?.value
    await send('Runtime.enable')

    const selCount = () => evaluate(`document.querySelectorAll('.console-row.selected').length`)

    // coordinates for the sweep, client CSS px (CDP input space)
    const prep = JSON.parse(await evaluate(`(() => {
        document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))  // reset
        const rows = [...document.querySelectorAll('.console-row')]
        if (rows.length < 4) return JSON.stringify({ err: 'rows=' + rows.length })
        const c = r => { const b = r.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } }
        const all = rows.slice(0, 4).map(c)
        return JSON.stringify({ all, count: rows.length })
    })()`))
    if (prep.err) { throw new Error('need ≥4 rows — run recorderShot.js first (' + prep.err + ')') }
    // ctrl-select rows 0 and 2; sweep rows[1] → rows[3]
    const pts = { a: prep.all[1], b: prep.all[3] }
    console.log(`sweep ${JSON.stringify(pts.a)} → ${JSON.stringify(pts.b)} over ${prep.count} rows`)

    // establish a 2-row multi-selection (component logic — plain DOM synth)
    await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        rows[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        return 'ok'
    })()`)
    console.log(`multi-select before sweep: ${await selCount()}`)

    // REAL sweep through Chromium's input pipeline: press on rows[1], drag
    // down through rows[2] to rows[3], release — plain modifiers
    const move = (p) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pts.a.x, y: pts.a.y, button: 'left', buttons: 1, clickCount: 1 })
    await sleep(120)
    for (const p of prep.all.slice(2)) {
        await move(p)
        await sleep(90)
    }
    await sleep(120)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pts.b.x, y: pts.b.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(900)

    console.log(`selection after REAL sweep: ${await selCount()}`)
    console.log('--- [wv-sel] timeline ---')
    for (const l of log) { console.log('  ' + l) }
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
