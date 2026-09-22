/** Check current-tab-indicator visibility per header + matching CSS rules. */
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

    const out = await evalRes(`(() => {
        const rows = [...document.querySelectorAll('tab-header')].map(h => {
            const ind = h.querySelector('.current-tab-indicator')
            const cs = ind ? getComputedStyle(ind) : null
            return {
                title: (h.querySelector('.name')?.textContent || '').trim().slice(0, 40),
                headerActive: h.classList.contains('active'),
                indicatorPresent: !!ind,
                indDisplay: cs?.display, indVisibility: cs?.visibility, indOpacity: cs?.opacity,
                indHeight: cs?.height, indBackground: cs?.backgroundColor, indTop: cs?.top, indBottom: cs?.bottom,
            }
        })
        // find CSS rules mentioning current-tab-indicator across stylesheets
        const rules = []
        for (const ss of document.styleSheets) {
            let cssRules
            try { cssRules = ss.cssRules } catch (e) { continue }
            const walk = (list) => {
                for (const r of list) {
                    if (r.cssRules) walk(r.cssRules)
                    if (r.selectorText && r.selectorText.includes('current-tab-indicator')) {
                        rules.push(r.selectorText + ' { ' + r.style.cssText + ' }')
                    }
                }
            }
            walk(cssRules)
        }
        return JSON.stringify({ rows, rules: [...new Set(rules)] }, null, 1)
    })()`)
    console.log(out)
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
