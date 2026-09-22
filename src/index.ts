import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import TabbyCoreModule, { ConfigProvider, ProfileProvider, TabContextMenuItemProvider, TabRecoveryProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { WebViewerConfigProvider } from './config'
import { WebViewerProfileProvider } from './profileProvider'
import { WebViewerProfileSettingsComponent } from './profileSettings.component'
import { RecorderPanelComponent } from './recorder/recorderPanel.component'
import { RecorderTabComponent } from './recorder/recorderTab.component'
import { WebViewerTabRecoveryProvider } from './recovery'
import { WebViewerSettingsTabProvider } from './settings'
import { WebViewerSettingsTabComponent } from './settingsTab.component'
import { WebViewerTabComponent } from './webviewerTab.component'
import { WebViewerTabContextMenuProvider } from './tabContextMenu'

@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        { provide: ProfileProvider, useClass: WebViewerProfileProvider, multi: true },
        { provide: TabRecoveryProvider, useClass: WebViewerTabRecoveryProvider, multi: true },
        { provide: ConfigProvider, useClass: WebViewerConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: WebViewerSettingsTabProvider, multi: true },
        { provide: TabContextMenuItemProvider, useClass: WebViewerTabContextMenuProvider, multi: true },
    ],
    declarations: [
        WebViewerTabComponent,
        WebViewerProfileSettingsComponent,
        WebViewerSettingsTabComponent,
        RecorderPanelComponent,
        RecorderTabComponent,
    ],
    entryComponents: [
        WebViewerTabComponent,
        WebViewerProfileSettingsComponent,
        WebViewerSettingsTabComponent,
        RecorderTabComponent,
    ],
})
export default class WebViewerModule { }
