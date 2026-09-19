import { ConfigProvider } from 'tabby-core'

/** @hidden */
export class WebViewerConfigProvider extends ConfigProvider {
    defaults = {
        webviewer: {
            // Scheme prepended to bare hosts typed in the address bar /
            // Quick Connect. localhost / IP hosts always use http.
            defaultScheme: 'https',
        },
    }
    platformDefaults = {}
}
