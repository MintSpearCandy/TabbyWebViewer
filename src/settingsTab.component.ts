import { Component } from '@angular/core'
import { ConfigService } from 'tabby-core'

import { clearAllWebViewerData, listWebViewerPartitions } from './dataManagement'

/** @hidden */
@Component({
    template: require('./settingsTab.component.pug'),
})
export class WebViewerSettingsTabComponent {
    defaultScheme: string
    recorderLayout: string
    partitionCount: number
    clearing = false
    clearedMessage: string | null = null

    constructor (public config: ConfigService) {
        this.defaultScheme = config.store.webviewer?.defaultScheme ?? 'https'
        const layout = config.store.webviewer?.recorderLayout
        this.recorderLayout = ['bottom', 'right', 'tab'].includes(layout) ? layout : 'right'
        this.partitionCount = listWebViewerPartitions().length
    }

    save (): void {
        const store = this.config.store
        store.webviewer ??= {}
        store.webviewer.defaultScheme = this.defaultScheme === 'http' ? 'http' : 'https'
        store.webviewer.recorderLayout = ['bottom', 'right', 'tab'].includes(this.recorderLayout) ? this.recorderLayout : 'right'
        this.config.save()
    }

    async clearAll (): Promise<void> {
        if (this.clearing) {
            return
        }
        this.clearing = true
        this.clearedMessage = null
        try {
            const n = await clearAllWebViewerData()
            this.partitionCount = listWebViewerPartitions().length
            this.clearedMessage = `Cleared ${n} partition${n === 1 ? '' : 's'}`
        } finally {
            this.clearing = false
        }
    }
}
