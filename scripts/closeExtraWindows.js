/** One-off: the restored session brought up an extra Tabby window; targets
 *  matching url.includes('index') then point at two windows and every script
 *  that picks the first match can land on the empty one. Close every main
 *  window that has no webviewer pane. */
const PORT = process.env.CDP_PORT || 9231

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const mains = targets.filter(t => t.type === 'page' && t.url.includes('index'))
    console.log(`main-window targets: ${mains.length}`)
    for (const t of mains) {
        const ws = new WebSocket(t.webSocketDebuggerUrl)
        await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
        const reply = await new Promise(r => {
            ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id === 1) r(m) })
            ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: '!!document.querySelector(\'webviewer-tab\')', returnByValue: true } }))
        })
        const hasPane = reply.result?.result?.value
        console.log(`  ${t.url.slice(0, 60)} → webviewer pane: ${hasPane}`)
        if (!hasPane) {
            await new Promise(r => {
                ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id === 2) r(m) })
                ws.send(JSON.stringify({ id: 2, method: 'Runtime.evaluate', params: { expression: `require('@electron/remote').getCurrentWindow().close()`, returnByValue: true } }))
            })
            console.log('  → closed (no pane)')
        }
        await new Promise(r => setTimeout(r, 300))
        ws.close()
    }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
