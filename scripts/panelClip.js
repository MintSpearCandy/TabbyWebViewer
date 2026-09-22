/** Cropped, zoomed screenshot of the recorder panel region.
 *    node scripts/panelClip.js out.png [scale] */
const fs = require('fs')
const PORT = process.env.CDP_PORT || 9231

async function main () {
    const OUT = process.argv[2] || 'test-env/panel-clip.png'
    const SCALE = parseFloat(process.argv[3] || '2')
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
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
    const evalRes = async expr => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
        return r.result?.result?.value
    }

    const rect = await evalRes(`(function () {
        const p = document.querySelector('webviewer-recorder-panel .webviewer-recorder')
        if (!p) return null
        const r = p.getBoundingClientRect()
        return { x: r.x, y: r.y, width: r.width, height: r.height }
    })()`)
    if (!rect) throw new Error('no panel')
    await send('Page.enable').catch(() => {})
    const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: rect.x, y: rect.y, width: rect.width, height: Math.min(rect.height, 200), scale: SCALE },
    })
    const data = shot?.result?.data
    if (!data) throw new Error('no screenshot data')
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'))
    console.log('saved', OUT, fs.statSync(OUT).size, 'bytes')
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
