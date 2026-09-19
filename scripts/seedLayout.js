/**
 * Seeds localStorage.tabsRecovery with a vertical split: local terminal
 * (top) + webviewer pane on example.com (bottom). Run against the isolated
 * instance (port 9233), then the operator restarts that instance to restore
 * the layout.
 */
async function main () {
    const targets = await (await fetch('http://127.0.0.1:9233/json/list')).json()
    const main = targets.filter(t => t.type === 'page').find(t => t.url.includes('index'))
    if (!main) {
        throw new Error('main window target not found — is the isolated instance running on 9233?')
    }
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
    const seed = {
        type: 'app:split-tab',
        ratios: [0.5, 0.5],
        orientation: 'v',
        children: [
            {
                type: 'app:local-tab',
                profile: {
                    id: 'local:cmd-e2e',
                    type: 'local',
                    name: 'cmd',
                    options: { command: 'C:\\WINDOWS\\system32\\cmd.exe', args: [] },
                },
            },
            {
                type: 'webviewer-tab',
                url: 'https://example.com',
                partitionId: 'p-e2e-nav',
                ignoreCertErrors: false,
            },
        ],
    }
    const r = await send('Runtime.evaluate', {
        expression: `(() => { localStorage.tabsRecovery = ${JSON.stringify(JSON.stringify(seed))}; return 'seeded: ' + localStorage.tabsRecovery.slice(0, 120) })()`,
        returnByValue: true,
    })
    console.log((r.result && r.result.result && r.result.result.value) || JSON.stringify(r).slice(0, 300))
    ws.close()
}

main().catch(e => console.error('SEED FAILED:', e.message))
