/** Inspect /html/body/app-root/div/div/div[1]/div[1]/tab-header[5]/div[1] and siblings. */
async function main () {
    const list = await (await fetch('http://127.0.0.1:9231/json/list')).json()
    const t = list.find(x => x.type === 'page' && x.url.includes('index'))
    if (!t) throw new Error('main window target not found')
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
        const XP = '/html/body/app-root/div/div/div[1]/div[1]/tab-header[5]/div[1]'
        const snap = () => {
            const r = document.evaluate(XP, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null)
            return r.singleNodeValue
        }
        const el = snap()
        const describe = (n) => {
            if (!n) return null
            const cs = getComputedStyle(n)
            const rect = n.getBoundingClientRect()
            return {
                tag: n.tagName.toLowerCase(),
                cls: n.className,
                text: (n.textContent || '').trim().slice(0, 120),
                outerStart: n.outerHTML.slice(0, 700),
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                display: cs.display, position: cs.position, visibility: cs.visibility, opacity: cs.opacity,
                animation: cs.animationName, transition: cs.transitionProperty,
            }
        }
        // parent tab-header context
        const th = document.evaluate(XP + '/ancestor::tab-header[1]', document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue
        const allHeaders = [...document.querySelectorAll('tab-header')].map((h, i) => ({
            idx: i + 1,
            cls: h.className,
            childTags: [...h.children].map(c => c.tagName.toLowerCase() + (c.className ? '.' + String(c.className).split(' ').join('.') : '')),
            title: (h.textContent || '').trim().slice(0, 60),
        }))
        return JSON.stringify({
            target: describe(el),
            targetParentHeader: describe(th),
            headerCount: allHeaders.length,
            allHeaders,
        }, null, 1)
    })()`)
    console.log(out)
    ws.close()
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
