import { Component } from '@angular/core'

import { WebViewerProfile } from './api'

/** @hidden */
@Component({
    template: require('./profileSettings.component.pug'),
})
export class WebViewerProfileSettingsComponent {
    // Injected by tabby-settings as a ConfigProxy over the profile
    profile: WebViewerProfile

    /** A profile-scoped partition id means "share data between panes of this profile". */
    get sharedPartition (): boolean {
        return !!this.profile.options.partitionId?.startsWith('profile-')
    }

    onSharedPartitionChange (v: boolean): void {
        this.profile.options.partitionId = v
            ? 'profile-' + String(this.profile.id).replace(/[^a-z0-9-]+/gi, '-').toLowerCase()
            : null
    }
}
