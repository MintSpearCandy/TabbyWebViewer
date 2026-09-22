/**
 * E2E for the session recorder: opens a pane on a local test page, clicks
 * record, drives console/network/DOM activity from the page target, then
 * asserts the drawer's DOM (rows, counts, filter, password masking, F12
 * pause/resume, stop/start).
 *
 *   node scripts/recorderTest.js
 * Pre: Tabby running with --remote-debugging-port=9231 and the fresh build
 */
const http = require('http')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PORT = process.env.CDP_PORT || 9231
const SITE = 9311
/** Unique per-run URL marker — recovered panes from earlier runs may sit on
 *  the same site, so target selection must be exact. */
const RUN = 'run' + Date.now()
const PAGE_URL = `http://127.0.0.1:${SITE}/?${RUN}`

// ---------------------------------------------------------------- server ---
const PAGE = `<!doctype html><html><body>
<input id="name" placeholder="name"><input id="pw" type="password">
<button id="go">Go</button><button id="addimg">Add image</button>
<div id="out"></div>
<script>
document.getElementById('go').addEventListener('click', function () { console.log('clicked go'); });
document.getElementById('addimg').addEventListener('click', function () {
    var i = document.createElement('img'); i.src = '/logo2.svg?x=' + Date.now(); document.body.appendChild(i);
});
</script></body></html>`

function svg (color) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="${color}"/></svg>`
}

function startSite () {
    return new Promise(resolve => {
        const srv = http.createServer((req, res) => {
            const u = req.url.split('?')[0]
            if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE) }
            else if (u === '/logo.svg' || u === '/logo2.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end(svg('#4af')) }
            else if (u === '/api/data') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"n":1}') }
            else if (u === '/api/missing') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"e":"nope"}') }
            else if (u === '/api/redirect') { res.writeHead(302, { location: '/api/data' }); res.end() }
            else { res.writeHead(404); res.end() }
        })
        srv.listen(SITE, '127.0.0.1', () => resolve(srv))
    })
}

// ------------------------------------------------------------------- cdp ---
async function connect (url) {
    const ws = new WebSocket(url)
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
    let id = 0
    const pend = new Map()
    const listeners = []
    ws.addEventListener('message', ev => {
        const m = JSON.parse(ev.data)
        if (m.id !== undefined && pend.has(m.id)) {
            pend.get(m.id)(m)
            pend.delete(m.id)
        } else {
            listeners.forEach(l => l(m))
        }
    })
    return {
        send: (method, params = {}) => {
            const i = ++id
            ws.send(JSON.stringify({ id: i, method, params }))
            return new Promise(r => pend.set(i, r))
        },
        on: fn => listeners.push(fn),
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

// ------------------------------------------------------------- assertions ---
let failed = 0
function check (label, ok, extra = '') {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !extra ? '' : ` — ${extra}`}`)
    if (!ok) { failed++ }
}

const PANEL = `document.querySelector('webviewer-recorder-panel')`

/** Set an ngModel input from outside Angular: value + input event. */
const SET_FILTER = expr => `(() => {
    const el = document.querySelector('.recorder-filter')
    if (!el) return 'no-input'
    el.value = ${JSON.stringify(expr)}
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return 'ok'
})()`

async function main () {
    const srv = await startSite()
    const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const mainT = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!mainT) throw new Error('main window not found')
    const ms = await connect(mainT.webSocketDebuggerUrl)
    const errors = []
    ms.on(m => {
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
            const t = m.params.args.map(a => a.value ?? a.description ?? '').join(' ')
            if (/EXCEPTION|Unhandled/i.test(t)) errors.push(t.slice(0, 200))
        }
    })
    await ms.send('Runtime.enable')

    // 1. open a pane if needed, then ALWAYS navigate the FIRST pane to the
    //    test page via its address bar (ngModel input + Enter) ---------------
    if (await evaluate(ms, `document.querySelectorAll('webviewer-tab').length`) === 0) {
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
                for (let k = 0; k < 6 && row.parentElement; k++) {
                    row = row.parentElement
                    if (row.tagName === 'LI' || row.tagName === 'A') break
                }
                row.click()
                return 'clicked'
            }
            return 'not-found'
        })()`)
        for (let i = 0; i < 30; i++) {
            await sleep(300)
            if (await evaluate(ms, `document.querySelectorAll('webviewer-tab').length`) > 0) break
        }
        await sleep(400)
    }
    // Navigate the first pane (the one we will record) to the test page
    await evaluate(ms, `(() => {
        const el = document.querySelector('webviewer-tab .webviewer-address')
        el.value = '127.0.0.1:${SITE}/?${RUN}'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return 'ok'
    })()`)
    let pageLoaded = false
    for (let i = 0; i < 30; i++) {
        await sleep(400)
        const url = await evaluate(ms, `(() => {
            const r = require('@electron/remote')
            const v = r.getCurrentWindow().contentView.children
                .find(v => (v.webContents.getURL() || '').startsWith('${PAGE_URL}'))
            return v ? v.webContents.getURL() : ''
        })()`)
        if (url.startsWith(PAGE_URL)) { pageLoaded = true; break }
    }
    check('pane open + test page loaded', pageLoaded)

    // 2. reset any leftover recorder state from earlier runs, then record ----
    // Converge to (no panel, not recording): a hidden-but-recording drawer
    // makes the record button RE-SUMMON (not stop), so cycle explicitly —
    // stop an open recorder, re-summon a hidden one, close+dispose a stopped
    // one — until clean.
    for (let i = 0; i < 6; i++) {
        const st = await evaluate(ms, `(() => ({
            panel: document.querySelector('webviewer-recorder-panel') !== null,
            rec: document.querySelector('webviewer-tab .recording-active') !== null,
        }))()`)
        if (!st.panel && !st.rec) {
            break
        }
        if (st.rec) {
            await evaluate(ms, `document.querySelector('webviewer-tab .fa-circle-dot')?.closest('button')?.click()`)  // stop (or re-summon if hidden)
        } else {
            await evaluate(ms, `document.querySelector('webviewer-recorder-panel .fa-chevron-down')?.closest('button')?.click()`)  // close → dispose
        }
        await sleep(400)
    }

    await evaluate(ms, `document.querySelector('webviewer-tab .fa-circle-dot')?.closest('button')?.click() ?? 'no-btn'`)
    await sleep(300)
    let hasPanel = await evaluate(ms, `!!${PANEL}`)
    check('drawer opened', hasPanel)
    let active = false
    for (let i = 0; i < 12; i++) {
        await sleep(300)
        if (await evaluate(ms, `document.querySelector('webviewer-tab .recording-active') !== null`)) { active = true; break }
    }
    check('record button pulsing', active)
    check('tabs: plain UI buttons with label + dim count', await evaluate(ms, `(() => {
        const t = document.querySelector('.recorder-tab')
        return !!t && !t.classList.contains('btn-link') && !t.classList.contains('btn')
            && !!t.querySelector('.r-tab-label') && !!t.querySelector('.r-tab-count')
    })()`))

    // header geometric stability: one fixed-height row — tabs/actions blocks
    // keep identical rects on EVERY tab (the network-only tools block lives
    // inside the row), and the active tab's TOP edge matches an inactive
    // tab's (activation may only change its lower face)
    const headerRect = sel => evaluate(ms, `(() => {
        const el = document.querySelector('${sel}')
        if (!el) return null
        const b = el.getBoundingClientRect()
        // position only — widths legitimately change as tab counts grow
        return Math.round(b.x * 10) + ',' + Math.round(b.y * 10)
    })()`)
    const tabTops = () => evaluate(ms, `(() => {
        const act = document.querySelector('.recorder-tab.active')
        const inact = [...document.querySelectorAll('.recorder-tab')].find(t => !t.classList.contains('active'))
        if (!act || !inact) return null
        return Math.abs(act.getBoundingClientRect().y - inact.getBoundingClientRect().y).toFixed(1)
    })()`)
    const rectConsole = await headerRect('.recorder-header') + '|' + await headerRect('.recorder-tabs') + '|' + await headerRect('.recorder-actions')
    let geomOk = true, geomWhy = ''
    for (const [name, idx] of [['network', 1], ['events', 2]]) {
        await evaluate(ms, `(() => { const t = [...document.querySelectorAll('.recorder-tab')][${idx}]; if (t) t.click(); return 1 })()`)
        await sleep(350)
        const rect = await headerRect('.recorder-header') + '|' + await headerRect('.recorder-tabs') + '|' + await headerRect('.recorder-actions')
        if (rect !== rectConsole) { geomOk = false; geomWhy += ` ${name}: ${rectConsole} → ${rect}` }
        const tops = await tabTops()
        if (tops === null || parseFloat(tops) > 0.3) { geomOk = false; geomWhy += ` ${name}:tops=${tops}` }
    }
    await evaluate(ms, `(() => { const t = [...document.querySelectorAll('.recorder-tab')][0]; if (t) t.click(); return 1 })()`)
    await sleep(300)
    check('header row geometrically stable across tab switches', geomOk,
        geomWhy ? ('header|tabs|actions rects' + geomWhy) : 'identical on console/network/events; active top = inactive top')

    check('bottom layout: drawer sits BELOW the page area', await evaluate(ms, `(() => {
        const pane = document.querySelector('webviewer-tab')
        const host = pane?.querySelector('webviewer-recorder-panel')
        const content = pane?.querySelector('.webviewer-content')
        return !!host && !!content && host.getBoundingClientRect().y > content.getBoundingClientRect().y
    })()`))
    const drawerH0 = await evaluate(ms,
        `Math.round(document.querySelector('webviewer-tab webviewer-recorder-panel')?.getBoundingClientRect().height ?? 0)`)

    // navigate once DURING recording (hash nav → navigate event + document reload)
    await evaluate(ms, `(() => {
        const el = document.querySelector('webviewer-tab .webviewer-address')
        el.value = '127.0.0.1:${SITE}/?${RUN}#rec'
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return 'ok'
    })()`)
    await sleep(1500)

    // 3. drive page activity --------------------------------------------------
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const pageT = list.find(t => t.url.startsWith(PAGE_URL))
    if (!pageT) throw new Error('page target not found')
    const ps = await connect(pageT.webSocketDebuggerUrl)
    await evaluate(ps, `(() => {
        console.log('hello log'); console.info('hello info'); console.warn('hello warn')
        console.error('hello error'); console.debug('hello debug')
        setTimeout(() => { null.x }, 50)
        fetch('/api/data').then(r => r.json()).then(j => console.log('data ok ' + j.n)).catch(() => {})
        fetch('/api/missing').catch(() => {})
        fetch('/api/redirect').catch(() => {})
        const name = document.querySelector('#name'); name.value = 'Tabby'
        name.dispatchEvent(new Event('input', { bubbles: true }))
        const pw = document.querySelector('#pw'); pw.value = 'secret123'
        pw.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('#addimg').click()
        document.querySelector('#go').click()
        for (let i = 0; i < 150; i++) { console.log('flood ' + i) }
        return 'ok'
    })()`)
    await sleep(2000)

    // 4. console assertions ----------------------------------------------------
    const consoleText = await evaluate(ms, `[...document.querySelectorAll('.console-row')].map(r => r.textContent).join('\\n')`)
    check('console: all 5 levels', ['hello log', 'hello info', 'hello warn', 'hello error', 'hello debug']
        .every(s => consoleText.includes(s)), consoleText.slice(0, 200))
    check('console: uncaught exception captured', consoleText.includes('UNCAUGHT') && consoleText.includes('null'))
    check('console: fetch log captured', consoleText.includes('data ok 1'))

    // narrow-drawer behaviors: emit a LONG console line through the page —
    // the row must never fold (summary stays one line, the LIST scrolls
    // horizontally) and the header must wrap into two lines instead of
    // squeezing the toolbar into the tabs
    await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const win = r.getCurrentWindow()
        const f = win.webContents.getZoomFactor()
        const content = document.querySelector('webviewer-tab webviewer-recorder-panel')
            ?.closest('webviewer-tab')?.querySelector('.webviewer-content')
        const cr = content.getBoundingClientRect()
        const hit = win.contentView.children
            .map(v => ({ wc: v.webContents, b: v.getBounds() }))
            .find(v => v.b.width > 50 && Math.abs(v.b.x - cr.x * f) < 12
                && Math.abs(v.b.y - cr.y * f) < 12 && Math.abs(v.b.width - cr.width * f) < 30)
        if (!hit) return 'no-view'
        hit.wc.executeJavaScript('console.log("LONGLINE " + "x".repeat(1200))').catch(() => {})
        return 'emitted'
    })()`)
    await sleep(1200)
    const narrow = JSON.parse(await evaluate(ms, `(() => {
        const scroll = document.querySelector('.recorder-body .recorder-scroll')
        const widths = [...document.querySelectorAll('.console-row .row-summary')]
            .map(s => Math.round(s.getBoundingClientRect().width))
        const h = document.querySelector('.recorder-header')
        const tabs = document.querySelector('.recorder-tabs')
        const actions = document.querySelector('.recorder-actions')
        return JSON.stringify({
            scrolls: !!scroll && scroll.scrollWidth > scroll.clientWidth + 5,
            summaryExceeds: widths.some(w => w > scroll.clientWidth),
            actionsNotAboveTabs: actions.getBoundingClientRect().y >= tabs.getBoundingClientRect().y - 1,
            actionsRight: Math.abs((actions.getBoundingClientRect().right) - h.getBoundingClientRect().right + 6) < 2,
        })
    })()`))
    check('long row never folds — list scrolls horizontally',
        narrow.scrolls && narrow.summaryExceeds, JSON.stringify(narrow))
    check('narrow header wraps toolbar below the tabs (actions stay right-aligned)',
        narrow.actionsNotAboveTabs && narrow.actionsRight)

    // row expansion (DevTools-style drop-down detail)
    await evaluate(ms, `document.querySelector('.console-row')?.click()`)
    await sleep(300)
    check('console row expands to inline detail', await evaluate(ms, `document.querySelectorAll('.console-row .row-detail').length`) === 1)
    check('expanded detail shows full text', (await evaluate(ms, `document.querySelector('.console-row .row-detail')?.textContent ?? ''`)).includes('hello log'))
    await evaluate(ms, `document.querySelector('.console-row')?.click()`)
    await sleep(200)
    check('console row detail collapses', await evaluate(ms, `document.querySelectorAll('.console-row .row-detail').length`) === 0)

    // 4b. selection + copy ----------------------------------------------------
    // clicking INSIDE the detail block must not collapse the row
    await evaluate(ms, `document.querySelector('.console-row')?.click()`)
    await sleep(250)
    await evaluate(ms, `document.querySelector('.console-row .row-detail')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(200)
    check('click inside detail does not collapse', await evaluate(ms, `document.querySelectorAll('.console-row .row-detail').length`) === 1)
    await evaluate(ms, `document.querySelector('.console-row')?.click()`)
    await sleep(200)

    // ctrl+click toggles one-row selection
    await evaluate(ms, `(() => {
        document.querySelectorAll('.console-row')[0]
            ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        return 'ok'
    })()`)
    await sleep(200)
    check('ctrl+click selects a row', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 1)

    // sweep: press row0, enter row2, release → range of 3
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        rows[2].dispatchEvent(new MouseEvent('mouseenter'))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return 'ok'
    })()`)
    await sleep(200)
    check('sweep selects the swept range (3 rows)', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 3)

    // mid-gesture a sweep NEVER clears: prior selection stays visible as a
    // union while the button is held; the release settles it
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[3].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        return 'ok'
    })()`)
    await sleep(150)
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))  // snapshot = 4 rows
        rows[2].dispatchEvent(new MouseEvent('mouseenter'))                    // sweep, NO mouseup yet
        return 'ok'
    })()`)
    await sleep(200)
    check('mid-sweep keeps the prior selection (union, 4 rows)',
        await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 4)
    await evaluate(ms, `document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))`)
    await sleep(200)
    check('plain sweep settles to the swept range (3 rows)',
        await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 3)

    // ctrl+drag sweeps ADDITIVELY: the pre-existing selection survives release
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[3].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        rows[3].dispatchEvent(new MouseEvent('mouseenter'))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return 'ok'
    })()`)
    await sleep(200)
    check('ctrl sweep stays additive (4 rows after release)',
        await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 4)

    // the trailing click after a sweep must NOT toggle expansion (same
    // gesture, release happened on a row)
    await evaluate(ms, `document.querySelectorAll('.console-row')[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)
    await sleep(200)
    check('sweep suppresses the trailing click-expand', await evaluate(ms, `document.querySelectorAll('.console-row .row-detail').length`) === 0)
    // REAL-BROWSER sweep variant: the trailing click fires on the
    // mousedown/mouseup targets' COMMON ANCESTOR (the list container), never
    // on a row — the suppression flag survives it. The user's NEXT plain
    // click on a row must still work (regression: it used to be swallowed)
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        rows[2].dispatchEvent(new MouseEvent('mouseenter'))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        document.querySelector('.recorder-scroll')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return 'ok'
    })()`)
    await sleep(200)
    check('real-sweep trailing click (on container) keeps the selection', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 3)
    // …and the next plain click on a row dismisses + expands (v0.4.9 fix:
    // a fresh mousedown resets the leftover suppression first)
    await evaluate(ms, `(() => {
        const row = document.querySelectorAll('.console-row')[1]
        row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        return 'ok'
    })()`)
    await sleep(250)
    check('plain click after a real sweep dismisses the selection', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 0)
    check('plain click after a real sweep still expands', await evaluate(ms, `document.querySelectorAll('.console-row .row-detail').length`) === 1)
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
        rows[2].dispatchEvent(new MouseEvent('mouseenter'))
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return 'ok'
    })()`)
    await sleep(200)
    check('re-sweep restores the selection for copy', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 3)

    // The Windows clipboard can be held open by another process (all writes
    // then fail silently, system-wide) — probe health once and skip the
    // CONTENT checks if locked; the copy pathway is still exercised.
    const clipOk = await evaluate(ms, `(() => {
        try {
            const c = require('@electron/remote').getBuiltin('clipboard')
            c.writeText('__wv_clip_probe__')
            return c.readText() === '__wv_clip_probe__'
        } catch (e) { return false }
    })()`)
    if (!clipOk) {
        console.log('  NOTE  system clipboard locked by another process — copy-content checks skipped')
    }

    // ctrl+c: 3 rows selected, middle one expanded → summary + detail + summary
    let clip1 = ''
    if (clipOk) {
        await evaluate(ms, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }))`)
        await sleep(300)
        clip1 = await evaluate(ms, `require('@electron/remote').getBuiltin('clipboard').readText()`)
    }
    check('ctrl+c composes summaries + expanded detail',
        !clipOk || (typeof clip1 === 'string' && clip1.includes('[LOG] hello log')
            && clip1.includes('hello info') && clip1.includes('[WARN] hello warn')),
        String(clip1).slice(0, 160))

    // the expanded row contributes its DETAIL (meta header + full text), the
    // collapsed neighbours keep their one-line summaries
    let clip2 = ''
    if (clipOk) {
        await evaluate(ms, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, cancelable: true }))`)
        await sleep(300)
        clip2 = await evaluate(ms, `require('@electron/remote').getBuiltin('clipboard').readText()`)
    }
    check('expanded row copies full detail', !clipOk || /#\d+ (log|info|warn|error|debug) t=\d+ms/.test(clip2), String(clip2).slice(0, 160))

    // DOM context menu: browser-placed at the click point, no coordinate math
    await evaluate(ms, `document.querySelector('.console-row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 150, clientY: 300 }))`)
    await sleep(250)
    const menuPos = await evaluate(ms, `(() => {
        const m = document.querySelector('.wv-ctx-menu')
        if (!m) return null
        const r = m.getBoundingClientRect()
        return { x: Math.round(r.x), y: Math.round(r.y), text: (m.textContent || '').trim() }
    })()`)
    check('DOM context menu opens exactly at the click point (150,300)',
        !!menuPos && Math.abs(menuPos.x - 150) <= 2 && Math.abs(menuPos.y - 300) <= 2,
        JSON.stringify(menuPos))
    await evaluate(ms, `[...document.querySelectorAll('.wv-ctx-item')][0]?.click()`)
    await sleep(250)
    check('menu closes after the item action', await evaluate(ms, `document.querySelector('.wv-ctx-menu') === null`))
    if (clipOk) {
        const clip3 = await evaluate(ms, `require('@electron/remote').getBuiltin('clipboard').readText()`)
        check('menu 复制 writes the clipboard', clip3.includes('[LOG]') || clip3.includes('[#'), String(clip3).slice(0, 80))
    }
    await evaluate(ms, `document.querySelector('.console-row')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 320 }))`)
    await sleep(200)
    await evaluate(ms, `document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)
    check('outside click closes the menu', await evaluate(ms, `document.querySelector('.wv-ctx-menu') === null`))

    // selection dismissal (v0.4.9): click-away + focus-loss paths
    await evaluate(ms, `(() => {
        const rows = [...document.querySelectorAll('.console-row')]
        rows[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        rows[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))
        return 'ok'
    })()`)
    await sleep(200)
    check('ctrl+click re-selects 2 rows', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 2)
    await evaluate(ms, `document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
    await sleep(200)
    check('click outside the panel dismisses the selection', await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`) === 0)
    await evaluate(ms, `document.querySelectorAll('.console-row')[0]
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))`)
    // focus the pane's view in its OWN evaluate: the dismiss runs through
    // zone.run from the remote 'focus' event — same-stack mousedown+focus
    // races the zone microtask and can lose
    // REAL user path: a click INSIDE the page. The view usually already
    // holds the webContents focus (DOM clicks don't shift it), so no focus
    // event fires — the injected script's click report (binding → recorder
    // → onPageInteract → panel.clearSelection) is the only signal chain.
    // Drive it through the PAGE target, exactly as a user click would.
    await evaluate(ms, `document.querySelectorAll('.console-row')[0]
        ?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, ctrlKey: true }))`)
    await evaluate(ps, `document.body.click()`)
    let selPage = -1
    for (let i = 0; i < 6; i++) {
        await sleep(400)
        selPage = await evaluate(ms, `document.querySelectorAll('.console-row.selected').length`)
        if (selPage === 0) { break }
    }
    check('click inside the page dismisses the selection', selPage === 0, `sel=${selPage}`)
    // consume the pending suppressNextClick left by the ctrl+click above: a
    // plain mousedown would reset it, but the next row interaction in this
    // test uses a bare .click() (no mousedown) — without this it would be
    // swallowed (the network-tab expansion check below)
    await evaluate(ms, `document.querySelectorAll('.console-row')[2]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))`)

    // 5. network assertions -----------------------------------------------------
    await evaluate(ms, `[...document.querySelectorAll('.recorder-tab')][1].click()`)
    await sleep(400)
    let netRows = await evaluate(ms, `[...document.querySelectorAll('.net-row')].map(r => r.textContent).join('\\n')`)
    check('network: api entries captured', /\/api\/data/.test(netRows), netRows.slice(0, 300))
    check('network: 404 captured', /\/api\/missing/.test(netRows) && netRows.includes('404'))
    check('network: redirect split into two entries', (netRows.match(/302/g) || []).length >= 1 && netRows.includes('200'))
    const netCount = await evaluate(ms, `document.querySelectorAll('.net-row').length`)

    // static assets: hidden by the default toggle → uncheck → visible → hide again
    const toggleStatics = on => `(() => {
        const el = document.querySelector('.recorder-statics input')
        if (el && el.checked !== ${on}) { el.click() }
        return 'ok'
    })()`
    await evaluate(ms, toggleStatics(false))
    await sleep(400)
    netRows = await evaluate(ms, `[...document.querySelectorAll('.net-row')].map(r => r.textContent).join('\\n')`)
    check('network: static svg captured (statics shown)', /logo2/.test(netRows), netRows.slice(0, 300))
    await evaluate(ms, toggleStatics(true))
    await sleep(400)

    // filter: status:404 → exactly the 404 row
    await evaluate(ms, SET_FILTER('status:404'))
    await sleep(400)
    let n404 = await evaluate(ms, `document.querySelectorAll('.net-row').length`)
    check('filter: status:404 → 1 row', n404 === 1, `got ${n404}`)
    const rowText = await evaluate(ms, `document.querySelector('.net-row')?.textContent ?? ''`)
    check('filter: 404 row is /api/missing', rowText.includes('api/missing'), rowText.slice(0, 150))

    // filter: hide statics via expression
    await evaluate(ms, SET_FILTER('-type:image'))
    await sleep(400)
    const noImg = await evaluate(ms, `[...document.querySelectorAll('.net-row')].map(r => r.textContent).join(' ')`)
    check('filter: -type:image hides svg', !noImg.includes('logo2'), noImg.slice(0, 200))

    // filter error → no filtering applied
    await evaluate(ms, SET_FILTER('bogus:key'))
    await sleep(400)
    const errShown = await evaluate(ms, `document.querySelector('.recorder-error')?.textContent ?? ''`)
    const allCount = await evaluate(ms, `document.querySelectorAll('.net-row').length`)
    check('filter error surfaced, list unfiltered', /Unknown filter key/.test(errShown) && allCount === netCount,
        `${errShown} / rows ${allCount} vs ${netCount}`)
    await evaluate(ms, SET_FILTER(''))

    // network row → inline multi-level detail (DevTools-style lazy sections)
    await evaluate(ms, `document.querySelector('.net-row')?.click()`)
    await sleep(300)
    check('network row expands inline (General section)', await evaluate(ms, `(() => {
        const d = document.querySelector('.net-row .row-detail')
        return !!d && d.textContent.includes('General') && d.textContent.includes('URL:')
    })()`))
    await evaluate(ms, `(() => {
        const heads = [...document.querySelectorAll('.net-row .nd-section-head')]
        const h = heads.find(x => x.textContent.includes('Request headers'))
        if (!h) return 'no-section'
        h.click()
        return 'ok'
    })()`)
    await sleep(300)
    check('Request headers section expands (lazy render)', await evaluate(ms, `(() => {
        const kv = [...document.querySelectorAll('.net-row .nd-section-body .nd-kv')]
        return kv.length > 0 && kv.some(x => /host|user-agent|connection|accept|content-type/i.test(x.textContent))
    })()`))
    await evaluate(ms, `(() => {
        const heads = [...document.querySelectorAll('.net-row .nd-section-head')]
        heads.find(x => x.textContent.includes('Request headers'))?.click()
        return 'ok'
    })()`)
    await sleep(200)
    check('Request headers section collapses', await evaluate(ms,
        `document.querySelectorAll('.net-row .nd-section-body .nd-kv').length`) === 0)
    await evaluate(ms, `document.querySelector('.net-row')?.click()`)

    // 6. events assertions --------------------------------------------------------
    await evaluate(ms, `[...document.querySelectorAll('.recorder-tab')][2].click()`)
    await sleep(400)
    const evText = await evaluate(ms, `[...document.querySelectorAll('.event-row')].map(r => r.textContent).join('\\n')`)
    check('events: input captured with value', /input/.test(evText) && evText.includes('Tabby'))
    check('events: password masked', evText.includes('••') && !evText.includes('secret123'), evText.slice(0, 200))
    check('events: clicks captured', (evText.match(/click/g) || []).length >= 2)
    check('events: navigation recorded', /navigate/.test(evText))
    await evaluate(ms, `document.querySelector('.event-row')?.click()`)
    await sleep(300)
    check('event row expands to inline detail', await evaluate(ms, `document.querySelectorAll('.event-row .row-detail').length`) === 1)

    // 7. F12 pause / resume --------------------------------------------------------
    await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const views = r.getCurrentWindow().contentView.children.filter(v => (v.webContents.getURL() || '').startsWith('${PAGE_URL}'))
        if (!views.length) return 'no-view'
        views[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
        return 'ok'
    })()`)
    await sleep(1500)
    const banner = await evaluate(ms, `document.querySelector('.recorder-banner')?.textContent ?? ''`)
    check('F12 → paused banner (devtools)', /暂停/.test(banner) && /DevTools/.test(banner), banner)
    check('F12 → button stops pulsing', await evaluate(ms, `document.querySelector('webviewer-tab .recording-active') === null`))

    await evaluate(ms, `(() => {
        const r = require('@electron/remote')
        const views = r.getCurrentWindow().contentView.children.filter(v => (v.webContents.getURL() || '').startsWith('${PAGE_URL}'))
        views[0].webContents.closeDevTools()
        return 'ok'
    })()`)
    await sleep(2000)
    const banner2 = await evaluate(ms, `document.querySelector('.recorder-banner')?.textContent ?? 'none'`)
    check('devtools closed → recording resumed', banner2 === 'none', banner2)
    check('resume → button pulsing again', await evaluate(ms, `document.querySelector('webviewer-tab .recording-active') !== null`))

    // 8. stop / start from the toolbar ------------------------------------------
    await evaluate(ms, `document.querySelector('webviewer-tab .recording-active')?.closest('button').click()`)
    await sleep(600)
    const stopBanner = await evaluate(ms, `document.querySelector('.recorder-banner')?.textContent ?? ''`)
    check('toolbar click → stopped', /已停止/.test(stopBanner), stopBanner)
    await evaluate(ms, `document.querySelector('webviewer-tab .fa-circle-dot')?.closest('button').click()`)
    await sleep(600)
    check('toolbar click → recording again', await evaluate(ms,
        `document.querySelector('.recorder-banner') === null && document.querySelector('webviewer-tab .recording-active') !== null`))

    // 9. data survives stop --------------------------------------------------------
    await evaluate(ms, `document.querySelector('webviewer-tab .recording-active')?.closest('button').click()`)  // stop again
    await sleep(400)
    await evaluate(ms, `[...document.querySelectorAll('.recorder-tab')][0].click()`)
    await sleep(300)
    check('data kept after stop', await evaluate(ms, `document.querySelectorAll('.console-row').length`) > 0)

    // 10. re-summon: hide drawer while recording → record click brings it back ----
    await evaluate(ms, `document.querySelector('webviewer-tab .fa-circle-dot')?.closest('button').click()`)  // start again
    await sleep(600)
    await evaluate(ms, `document.querySelector('webviewer-recorder-panel .fa-chevron-down')?.closest('button').click()`)  // hide
    await sleep(400)
    check('hide drawer keeps recording',
        await evaluate(ms, `document.querySelector('webviewer-recorder-panel') === null && document.querySelector('webviewer-tab .recording-active') !== null`))
    await evaluate(ms, `document.querySelector('webviewer-tab .fa-circle-dot')?.closest('button').click()`)  // re-summon
    await sleep(500)
    check('record click re-summons hidden drawer (still recording)',
        await evaluate(ms, `document.querySelector('webviewer-recorder-panel') !== null && document.querySelector('webviewer-tab .recording-active') !== null && document.querySelector('.recorder-banner') === null`))

    // 11. fixed height under a 150-entry flood -------------------------------
    const drawerH1 = await evaluate(ms,
        `Math.round(document.querySelector('webviewer-tab webviewer-recorder-panel')?.getBoundingClientRect().height ?? 0)`)
    check(`drawer height fixed under flood (${drawerH0}px → ${drawerH1}px)`, drawerH0 > 0 && Math.abs(drawerH1 - drawerH0) <= 1)

    console.log('')
    if (errors.length) {
        console.log('main-window errors during run:')
        errors.forEach(e => console.log('  ' + e))
    }
    console.log(failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`)
    ps.close()
    ms.close()
    srv.close()
    process.exitCode = failed === 0 ? 0 : 1
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
