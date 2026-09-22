/** Open a pane + recorder on the VISIBLE pane with some data, then screenshot
 *  the main window so the panel's actual rendering can be inspected.
 *    node scripts/recorderShot.js [out.png]
 */
const fs = require('fs')
const http = require('http')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9231
const SITE = 9311
const RUN = 'shot' + Date.now()
const PAGE_URL = `http://127.0.0.1:${SITE}/?${RUN}`
const OUT = process.argv[2] || 'test-env/recorder-shot.png'

const PAGE = `<!doctype html><html><body style="font-family:sans-serif">
<h3>Demo page</h3><input id="name" placeholder="name"><input id="pw" type="password">
<button id="go">Go</button><button id="addimg">Add image</button>
<script>
document.getElementById('go').addEventListener('click', function () { console.log('clicked go'); });
document.getElementById('addimg').addEventListener('click', function () {
    var i = document.createElement('img'); i.src = '/logo2.svg?x=' + Date.now(); document.body.appendChild(i);
});
</script></body></html>`
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#4af"/></svg>`

function startSite () {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const u = req.url.split('?')[0]
            if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) }
            else if (u === '/logo2.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(svg) }
            else if (u === '/api/data') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"n":1}') }
            else if (u === '/api/missing') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"e":"nope"}') }
            else if (u === '/api/redirect') { res.writeHead(302, { location: '/api/data' }); res.end() }
            else { res.writeHead(404); res.end() }
        })
        srv.listen(SITE, '127.0.0.1', () => resolve(srv))
    })
}

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
    if (inner.exceptionDetails) throw new Error(String((inner.exceptionDetails.exception || {}).description || '').slice(0, 300))
    return inner.result ? inner.result.value : undefined
}

async function main () {
    const srv = await startSite()
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const t = list.find(x => x.type === 'page' && x.url.includes('index'))
    const ms = await connect(t.webSocketDebuggerUrl)

    // reset any leftover recorder on the VISIBLE pane (stop + close), then
    // navigate it and start a fresh recording for the screenshot
    await evaluate(ms, `(() => {
        const vis = [...document.querySelectorAll('webviewer-tab')].find(p => p.getBoundingClientRect().x > -100)
        if (!vis) return 'no-vis'
        if (vis.querySelector('.recording-active')) {
            vis.querySelector('.fa-circle-dot')?.closest('button')?.click()
        }
        return 'ok'
    })()`)
    await sleep(300)
    await evaluate(ms, `document.querySelector('webviewer-recorder-panel .fa-chevron-down')?.closest('button')?.click()`)
    await sleep(300)
    // open a webviewer pane if none visible
    if (await evaluate(ms, `[...document.querySelectorAll('webviewer-tab')].some(p => p.getBoundingClientRect().x > -100)`) === false) {
        await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 2 })
        await ms.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 10 })
        await sleep(60)
        await ms.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'E', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: 10 })
        await sleep(100)
        await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'E', code: 'KeyE', windowsVirtualKeyCode: 69, modifiers: 10 })
        await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 2 })
        await ms.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, modifiers: 0 })
        await sleep(1000)
        await evaluate(ms, `(() => {
            const snap = document.evaluate("//*[normalize-space(text())='Web viewer']", document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            for (let i = 0; i < snap.snapshotLength; i++) {
                const el = snap.snapshotItem(i)
                const r = el.getBoundingClientRect()
                if (r.width < 5 || r.height < 5) continue
                let row = el
                for (let k = 0; k < 6 && row.parentElement; k++) { row = row.parentElement; if (row.tagName === 'LI' || row.tagName === 'A') break }
                row.click(); return 'ok'
            }
            return 'nf'
        })()`)
        for (let i = 0; i < 30; i++) { await sleep(300); if (await evaluate(ms, `document.querySelectorAll('webviewer-tab').length`) > 0) break }
        await sleep(400)
    }
    // navigate the visible pane
    await evaluate(ms, `(() => {
        const vis = [...document.querySelectorAll('webviewer-tab')].find(p => p.getBoundingClientRect().x > -100)
        const el = vis.querySelector('.webviewer-address')
        el.value = '127.0.0.1:${SITE}/?${RUN}'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return 'ok'
    })()`)
    await sleep(2000)
    // start recorder on the visible pane
    await evaluate(ms, `(() => {
        const vis = [...document.querySelectorAll('webviewer-tab')].find(p => p.getBoundingClientRect().x > -100)
        vis.querySelector('.fa-circle-dot')?.closest('button')?.click()
        return 'ok'
    })()`)
    await sleep(1200)

    const pageT = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find(x => x.url.startsWith(PAGE_URL))
    if (pageT) {
        const ps = await connect(pageT.webSocketDebuggerUrl)
        await evaluate(ps, `(() => {
            console.log('hello log'); console.warn('hello warn'); console.error('hello error')
            fetch('/api/data').catch(() => {}); fetch('/api/missing').catch(() => {}); fetch('/api/redirect').catch(() => {})
            const n = document.querySelector('#name'); n.value = 'Tabby'; n.dispatchEvent(new Event('input', { bubbles: true }))
            const pw = document.querySelector('#pw'); pw.value = 'secret'; pw.dispatchEvent(new Event('input', { bubbles: true }))
            document.querySelector('#go').click()
            return 'ok'
        })()`)
        await sleep(1500)
        ps.close()
    }
    await sleep(500)
    await ms.send('Page.enable').catch(() => {})
    const shot = await ms.send('Page.captureScreenshot', { format: 'png' })
    const data = shot?.result?.data
    if (!data) {
        throw new Error('screenshot failed: ' + JSON.stringify(shot).slice(0, 300))
    }
    fs.writeFileSync(OUT, Buffer.from(data, 'base64'))
    console.log('saved', OUT, fs.statSync(OUT).size, 'bytes')
    srv.close()
    ms.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
