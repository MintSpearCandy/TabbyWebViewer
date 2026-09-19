/** Extract a file from an (unencrypted) asar and search it for symbols.
 *  node scripts/asarScan.js <asar> <innerPath> sym1 sym2 ... */
const fs = require('fs')

function extractAsar (asarPath, innerPath) {
    const b = fs.readFileSync(asarPath)
    const jsonStart = b.indexOf('{')
    let depth = 0
    let end = -1
    let inStr = false
    let esc = false
    for (let i = jsonStart; i < b.length; i++) {
        const c = String.fromCharCode(b[i])
        if (inStr) {
            if (esc) {
                esc = false
            } else if (c === '\\') {
                esc = true
            } else if (c === '"') {
                inStr = false
            }
            continue
        }
        if (c === '"') {
            inStr = true
        } else if (c === '{') {
            depth++
        } else if (c === '}') {
            depth--
            if (!depth) {
                end = i + 1
                break
            }
        }
    }
    const header = JSON.parse(b.slice(jsonStart, end).toString())
    // Content begins after the header JSON, 4-byte aligned (asar pickle padding)
    const base = Math.ceil(end / 4) * 4
    const node = innerPath.split('/').reduce((n, seg) => n.files[seg], header)
    return b.slice(base + parseInt(node.offset), base + parseInt(node.offset) + node.size)
}

const [asar, inner] = process.argv.slice(2, 4)
const syms = process.argv.slice(4)
if (inner === '--list') {
    const b = fs.readFileSync(asar)
    const jsonStart = b.indexOf('{')
    let depth = 0
    let end = -1
    let inStr = false
    let esc = false
    for (let i = jsonStart; i < b.length; i++) {
        const c = String.fromCharCode(b[i])
        if (inStr) {
            if (esc) {
                esc = false
            } else if (c === '\\') {
                esc = true
            } else if (c === '"') {
                inStr = false
            }
            continue
        }
        if (c === '"') {
            inStr = true
        } else if (c === '{') {
            depth++
        } else if (c === '}') {
            depth--
            if (!depth) {
                end = i + 1
                break
            }
        }
    }
    const header = JSON.parse(b.slice(jsonStart, end).toString())
    const min = parseInt(syms[0] || '400000')
    const walk = (node, prefix) => {
        for (const [name, f] of Object.entries(node.files || {})) {
            const p = prefix + '/' + name
            if (f.files) {
                walk(f, p)
            } else if ((f.size || 0) > min) {
                console.log(f.size, p)
            }
        }
    }
    walk(header, '')
    process.exit(0)
}
const buf = extractAsar(asar, inner)
console.log(`${inner}: ${buf.length} bytes from ${asar}`)
if (syms[0] === '--head') {
    console.log(JSON.stringify(buf.slice(0, 300).toString()))
    process.exit(0)
}
for (const s of syms) {
    let n = 0
    let i = 0
    while ((i = buf.indexOf(s, i)) !== -1) {
        n++
        i += s.length
    }
    console.log(`  ${s}: ${n}`)
}
