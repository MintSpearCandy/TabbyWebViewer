/** Quick CDP probe: dump isolated Tabby UI state. Usage: CDP_PORT=9233 node scripts/cdpProbe.js [expression-file] */
const fs = require('fs')

const PORT = process.env.CDP_PORT || 9223

async function main () {
    const expr = fs.readFileSync(process.argv[2] || 'scripts/probe.expr.js', 'utf8')
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pages = targets.filter(t => t.type === 'page')
    const main = pages.find(t => t.url.includes('index.html')) || pages[0]
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise(r => ws.addEventListener('open', r))
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) {
            pend.get(m.id)(m)
            pend.delete(m.id)
        }
    })
    const send = (method, params = {}) => {
        const i = ++id
        ws.send(JSON.stringify({ id: i, method, params }))
        return new Promise(r => pend.set(i, r))
    }
    await send('Runtime.enable')
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
    const inner = r.result || {}
    if (inner.exceptionDetails) {
        console.log('EXCEPTION:', (inner.exceptionDetails.exception && inner.exceptionDetails.exception.description || inner.exceptionDetails.text).slice(0, 500))
    } else {
        const value = inner.result && inner.result.value
        console.log(value === undefined ? '(undefined)' : String(value).slice(0, 3000))
    }
    ws.close()
}

main().catch(e => console.error('PROBE FAILED:', e.message))
