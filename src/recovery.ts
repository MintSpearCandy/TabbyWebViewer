import { Injectable } from '@angular/core'
import { NewTabParameters, RecoveryToken, TabRecoveryProvider } from 'tabby-core'

import { makeWebViewerProfile } from './api'
import { WebViewerTabComponent } from './webviewerTab.component'

/** @hidden */
@Injectable()
export class WebViewerTabRecoveryProvider extends TabRecoveryProvider<WebViewerTabComponent> {
    async applicableTo (recoveryToken: RecoveryToken): Promise<boolean> {
        return recoveryToken.type === WebViewerTabComponent.RECOVERY_TYPE
    }

    async recover (recoveryToken: RecoveryToken): Promise<NewTabParameters<WebViewerTabComponent>> {
        const profile = makeWebViewerProfile({
            url: recoveryToken.url ?? '',
            // Both restart-restore and duplicate reuse the partition id:
            // logins survive restarts and duplicated panes keep their login
            // state (Chrome "duplicate tab" semantics). See the note in
            // WebViewerTabComponent.getRecoveryToken for making duplicates
            // isolated instead.
            partitionId: recoveryToken.partitionId ?? null,
            ignoreCertErrors: !!recoveryToken.ignoreCertErrors,
        })
        // autoFocusAddressBar: false — a recovered pane (restart restore or a
        // split/duplicate) must not steal focus into its address bar
        return { type: WebViewerTabComponent, inputs: { profile, autoFocusAddressBar: false } }
    }
}
