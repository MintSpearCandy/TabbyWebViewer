/**
 * Loads dist/index.js the way Tabby's renderer would (module evaluation
 * only), with the host modules stubbed. Any module-scope crash (the kind
 * that makes a plugin silently fail to load) reproduces here.
 *
 *   node scripts/smokeLoad.js
 */
const Module = require('module')
const path = require('path')
const assert = require('assert')

// ---------------------------------------------------------------- stubs ---
function decorator () { return (cls) => cls }

const Injector = class Injector {}
class NgZone { run (fn) { return fn() } runOutsideAngular (fn) { return fn() } }
class ChangeDetectorRef { detectChanges () {} }

const ngCore = new Proxy({
    Injector,
    NgZone,
    ChangeDetectorRef,
    // things only referenced as types get erased, but design:paramtypes
    // metadata requires them as values
    Component: decorator,
    NgModule: decorator,
    Injectable: (...a) => (cls, ...rest) => {
        // @Injectable({ providedIn: 'root' }) takes args
        return typeof cls === 'function' ? cls : decorator()
    },
    Input: decorator,
    ViewChild: decorator,
}, { get (t, k) { if (k in t) return t[k]; return decorator } })

class BaseTabComponent { constructor () {} }
class BaseComponent {}
class ProfileProvider {}
class QuickConnectProfileProvider extends ProfileProvider {}
class TabRecoveryProvider {}
class TabContextMenuItemProvider {}
class ConfigProvider {}
class AppService {}
class HotkeysService {}
class ConfigService { constructor () { this.store = {} } save () {} }
class TranslateService { instant (s) { return s } }
class SplitTabComponent extends BaseTabComponent {}
class PlatformService {}

function strictProxy (target, name) {
    return new Proxy(target, {
        get (t, k) {
            if (k === '__esModule' || typeof k === 'symbol') {
                return undefined
            }
            if (k in t) {
                return t[k]
            }
            throw new Error(`${name} export missing in stub: ${String(k)}`)
        },
    })
}

const tabbyCore = strictProxy({
    BaseTabComponent,
    BaseComponent,
    ProfileProvider,
    QuickConnectProfileProvider,
    TabRecoveryProvider,
    TabContextMenuItemProvider,
    ConfigProvider,
    AppService,
    HotkeysService,
    ConfigService,
    TranslateService,
    SplitTabComponent,
    PlatformService,
    TabbyCoreModule: {},
}, 'tabby-core')

const tabbySettings = strictProxy({
    SettingsTabProvider: class SettingsTabProvider {},
}, 'tabby-settings')

const electronStubs = {
    session: { fromPartition: () => ({ setCertificateVerifyProc () {}, clearStorageData: async () => {}, clearCache: async () => {} }) },
    Menu: { buildFromTemplate: () => ({ popup () {} }) },
    clipboard: { writeText () {} },
    shell: { openExternal () {} },
    app: { getPath: () => '.' },
    WebContentsView: class WebContentsView {
        constructor () { this.webContents = { on () {}, setWindowOpenHandler () {}, loadURL: async () => {}, close () {}, getURL: () => '' } }
        setBounds () {} setVisible () {}
    },
}
const electronRemote = {
    // Mirrors the real API: getBuiltin(name), NOT require('electron')
    getBuiltin: name => {
        if (!(name in electronStubs)) {
            throw new Error(`smoke stub has no builtin: ${name}`)
        }
        return electronStubs[name]
    },
    getCurrentWindow: () => ({ contentView: { addChildView () {}, removeChildView () {} } }),
    getCurrentWebContents: () => ({ getZoomFactor: () => 1, focus () {} }),
}

const STUBS = {
    '@angular/core': ngCore,
    '@angular/common': { CommonModule: {} },
    '@angular/forms': { FormsModule: {} },
    'tabby-core': tabbyCore,
    'tabby-settings': tabbySettings,
    '@electron/remote': electronRemote,
}

// Patch require BEFORE loading the bundle. The webpack UMD wrapper /
// external requires go through Module._load.
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) {
        return STUBS[request]
    }
    return origLoad.apply(this, [request, parent, isMain])
}

// ---------------------------------------------------------------- load ----
const dist = path.resolve(__dirname, '..', 'dist', 'index.js')
console.log('Loading', dist)
const mod = origLoad(dist, null, false)

assert.strictEqual(typeof mod.default, 'function', 'default export must be the NgModule class')
const exported = Object.keys(mod).filter(k => k !== 'default')
console.log('[ok] module evaluated; default export:', mod.default.name || '(anonymous)')
console.log('[ok] named exports:', exported.join(', ') || '(none)')

// Also evaluate every source of external usage at least once
console.log('[ok] smoke load passed')
