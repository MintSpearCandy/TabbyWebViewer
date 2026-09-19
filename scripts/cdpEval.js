/** One-off CDP eval helper: node scripts/cdpEval.js "expression" */
const PORT = process.env.CDP_PORT || 9231

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    console.log('targets:', targets.map(t => `${t.type} ${t.url.slice(0, 50)}`).join(' | '))
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) throw new Error('no main window')
    const ws = new WebSocket(main.webSocketDebuggerUrl)
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
    const evaluate = ex => new Promise(r => {
        const i = ++id
        pend.set(i, r)
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, returnByValue: true } }))
    })
    const r = await evaluate(process.argv[2])
    const out = r.result?.result
    if (out?.subtype === 'error') {
        console.log('ERROR:', out.description?.slice(0, 300))
    } else {
        console.log(typeof out?.value === 'string' ? out.value : JSON.stringify(out?.value))
    }
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
