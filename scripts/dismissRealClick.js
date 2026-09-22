/** End-to-end verification of the selection dismissal through the REAL
 *  signal chain (run after touching the dismissal plumbing):
 *
 *  click inside the page — the PRIMARY (and only reliable) path. The view
 *  is a separate webContents, and it usually already holds the webContents
 *  focus (DOM clicks don't shift it), so no focus event fires: the injected
 *  script's click report (CDP binding → recorder.onPageInteract →
 *  panel.clearSelection) is the chain that must catch it. Driven via
 *  wc.executeJavaScript on the pane's own (geometry-matched) view.
 *
 *  Prereq: clean visible layout — run `node scripts/recorderShot.js` first.
 *
 *  HISTORY (both approaches implemented, then REVERTED — do not re-add):
 *  - window:blur — the host DOM never holds webContents focus, so blur
 *    never fires for view clicks.
 *  - onFocusGained clearSelection — fires for PROGRAMMATIC view.focus()
 *    too: the pane's own claimKeyboardFocus() runs it whenever the user
 *    clicks in the drawer (main DOM focus → split re-emits pane focus),
 *    wiping the selection mid-gesture. Diagnosed 2026-09 via [wv-sel]
 *    stack logs under a CDP Input.dispatchMouseEvent sweep.
 *  Both lessons live in the webviewer-e2e skill pitfall list.
 */
const PORT = process.env.CDP_PORT || 9231
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function main () {
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) { throw new Error('main window target not found') }
    const ws = new WebSocket(main.webSocketDebuggerUrl)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) }
    })
    const evaluate = async ex => (await new Promise(r => {
        const i = ++id
        pend.set(i, r)
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: ex, returnByValue: true } }))
    })).result?.result?.value
    const selCount = () => evaluate(`document.querySelectorAll('.console-row.selected').length`)

    // reset any leftover selection (ctrl+click toggles!) and click inside
    // THIS pane's page — matched by GEOMETRY, not "first http view":
    // restored sessions carry other panes' views, and clicking those
    // dismisses THEIR (empty) panel instead
    await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await evaluate(`(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        if (rows.length < 2) throw new Error('need ≥2 console rows — run recorderShot.js first')
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        rows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        return 'ok'
    })()`)
    const before = await selCount()
    console.log(`selection before page click: ${before}`)
    if (before !== 2) { throw new Error('ctrl+click multi-select failed') }

    const clicked = await evaluate(`(() => {
        const r = require('@electron/remote')
        const win = r.getCurrentWindow()
        const f = win.webContents.getZoomFactor()
        const content = document.querySelector('webviewer-tab webviewer-recorder-panel')
            ?.closest('webviewer-tab')?.querySelector('.webviewer-content')
        if (!content) return 'no-drawer'
        const cr = content.getBoundingClientRect()
        const hit = win.contentView.children
            .map(v => ({ wc: v.webContents, b: v.getBounds() }))
            .find(v => v.b.width > 50 && Math.abs(v.b.x - cr.x * f) < 12
                && Math.abs(v.b.y - cr.y * f) < 12 && Math.abs(v.b.width - cr.width * f) < 30)
        if (!hit) return 'no-view'
        hit.wc.executeJavaScript('document.body.click()').catch(() => {})
        return 'clicked'
    })()`)
    let sel = -1
    for (let i = 0; i < 6; i++) {
        await sleep(400)
        sel = await selCount()
        if (sel === 0) { break }
    }
    console.log(`page click dispatch: ${clicked} · selection after: ${sel}`)
    ws.close()
    if (clicked !== 'clicked' || sel !== 0) {
        console.log('FAIL')
        process.exit(1)
    }
    console.log('PASS — a click inside the page dismisses the selection')
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
