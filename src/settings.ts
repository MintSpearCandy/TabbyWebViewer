import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { WebViewerSettingsTabComponent } from './settingsTab.component'

/** @hidden */
@Injectable()
export class WebViewerSettingsTabProvider extends SettingsTabProvider {
    id = 'webviewer'
    icon = 'globe'
    title = 'Web Viewer'

    getComponentType (): any {
        return WebViewerSettingsTabComponent
    }
}
