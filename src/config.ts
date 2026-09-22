import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class WebViewerConfigProvider extends ConfigProvider {
    defaults = {
        webviewer: {
            // Scheme prepended to bare hosts typed in the address bar /
            // Quick Connect. localhost / IP hosts always use http.
            defaultScheme: 'https',
            // Where the session recorder UI appears: 'bottom' drawer, 'right'
            // drawer (default), or 'tab' (detached Tabby tab, split-friendly)
            recorderLayout: 'right',
        },
    }
    platformDefaults = {}
}
