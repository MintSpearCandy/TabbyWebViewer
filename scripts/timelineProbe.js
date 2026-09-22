/** Clean real-right-click menu timeline: focus, move, click, in-process poll. */
const { execFileSync } = require('child_process')
const ps = (mode, ...args) => execFileSync('powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', 'scripts/osprobe.ps1', mode, ...args.map(String)],
    { encoding: 'utf8' }).trim()

async function main () {
    const list = await (await fetch('http://127.0.0.1:9231/json/list')).json()
    const t = list.find(x => x.type === 'page' && x.url.includes('index'))
    const ws = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    })
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })) })
    const evalRes = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.result?.value

    const g = JSON.parse(await evalRes(`(() => {
        const r = require('@electron/remote')
        const cb = r.getCurrentWindow().getContentBounds()
        const w = r.getCurrentWindow()
        const b = new Uint8Array(w.getNativeWindowHandle())
        let v = 0n
        for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i])
        const row = document.querySelector('.console-row')?.getBoundingClientRect()
        return JSON.stringify({ ox: cb.x, oy: cb.y, hwnd: v.toString(),
            row: row ? { x: row.x + 10, y: row.y + row.height / 2 } : null })
    })()`))
    if (!g.row) throw new Error('no console row')
    const physX = Math.round((g.ox + g.row.x) * 1.5)
    const physY = Math.round((g.oy + g.row.y) * 1.5)
    ps('focus-hwnd', g.hwnd)
    ps('move', physX, physY)
    console.log('target physical:', physX, physY)
    const mode = process.argv[2] || 'probe'
    if (mode === 'shot') {
        console.log(ps('rclick-shot', 'test-env/real-click-menu.png', '400'))
    } else {
        console.log(ps('rclick-probe'))
    }
    ps('esc')
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
