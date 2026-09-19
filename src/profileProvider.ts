import { Injectable } from '@angular/core'
import { NewTabParameters, PartialProfile, QuickConnectProfileProvider } from 'tabby-core'

import { hostnameOf, parseQuickConnectQuery, WEBVIEWER_PROFILE_TYPE, WebViewerProfile } from './api'
import { WebViewerProfileSettingsComponent } from './profileSettings.component'
import { WebViewerTabComponent } from './webviewerTab.component'

/** @hidden */
@Injectable({ providedIn: 'root' })
export class WebViewerProfileProvider extends QuickConnectProfileProvider<WebViewerProfile> {
    id = 'webviewer'
    name = 'Web viewer'
    settingsComponent = WebViewerProfileSettingsComponent
    configDefaults = {
        options: {
            url: '',
            partitionId: null,
            ignoreCertErrors: false,
        },
    }

    async getBuiltinProfiles (): Promise<PartialProfile<WebViewerProfile>[]> {
        return [
            // Single directly-launchable builtin entry. Saved profiles with
            // a URL are created via Tabby's own "Save tab as profile"
            // (tab context menu) — a separate template entry would show up
            // in the panel as a duplicate connection type
            {
                id: 'webviewer',
                type: WEBVIEWER_PROFILE_TYPE,
                name: 'Web viewer',
                icon: 'fas fa-globe',
                isBuiltin: true,
                options: {
                    url: '',
                    partitionId: null,
                    ignoreCertErrors: false,
                },
            } as PartialProfile<WebViewerProfile>,
        ]
    }

    async getNewTabParameters (profile: WebViewerProfile): Promise<NewTabParameters<WebViewerTabComponent>> {
        return { type: WebViewerTabComponent, inputs: { profile } }
    }

    quickConnect (query: string): PartialProfile<WebViewerProfile> | null {
        const url = parseQuickConnectQuery(query)
        if (!url) {
            return null
        }
        return {
            id: `webviewer:qc:${Date.now().toString(36)}`,
            type: WEBVIEWER_PROFILE_TYPE,
            name: hostnameOf(url),
            icon: 'fas fa-globe',
            // partitionId omitted → every pane gets its own fresh browsing identity
            options: { url },
        } as PartialProfile<WebViewerProfile>
    }

    intoQuickConnectString (profile: WebViewerProfile): string | null {
        return profile.options?.url || null
    }

    getSuggestedName (profile: PartialProfile<WebViewerProfile>): string | null {
        return profile.options?.url ? hostnameOf(profile.options.url) : 'Web viewer'
    }

    getDescription (profile: PartialProfile<WebViewerProfile>): string {
        return profile.options?.url ?? ''
    }
}
