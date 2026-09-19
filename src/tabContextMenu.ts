import { Injectable } from '@angular/core'
import { BaseTabComponent, MenuItemOptions, TabContextMenuItemProvider, TranslateService } from 'tabby-core'

import { clipboardWriteText } from './electronApi'
import { WebViewerTabComponent } from './webviewerTab.component'

/** @hidden */
@Injectable()
export class WebViewerTabContextMenuProvider extends TabContextMenuItemProvider {
    weight = 1

    constructor (private translate: TranslateService) {
        super()
    }

    async getItems (tab: BaseTabComponent): Promise<MenuItemOptions[]> {
        if (!(tab instanceof WebViewerTabComponent)) {
            return []
        }
        return [
            {
                label: this.translate.instant('Reload page'),
                click: () => setTimeout(() => tab.reload()),
            },
            {
                label: this.translate.instant('Copy current URL'),
                click: () => {
                    const url = tab.view?.currentUrl()
                    if (url) {
                        clipboardWriteText(url)
                    }
                },
            },
            {
                label: this.translate.instant('Open in system browser'),
                click: () => setTimeout(() => tab.openInSystemBrowser()),
            },
            {
                label: this.translate.instant('Clear browsing data'),
                click: () => setTimeout(() => tab.clearBrowsingData()),
            },
        ]
    }
}
