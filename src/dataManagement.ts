/**
 * @hidden
 * Disk-level browsing-data management. The renderer has nodeIntegration, so
 * persistent partitions can be enumerated straight from the filesystem:
 * a `persist:webviewer-<id>` session lives in <userData>/Partitions/webviewer-<id>.
 */
import * as fs from 'fs'
import * as path from 'path'

import { appGetPath, sessionFromPartition, shellOpenExternal } from './electronApi'

export function listWebViewerPartitions (): string[] {
    const dir = path.join(appGetPath('userData'), 'Partitions')
    try {
        return fs.readdirSync(dir).filter(n => n.startsWith('webviewer-'))
    } catch {
        return []
    }
}

/**
 * Wipes storage of every webviewer partition (including orphaned ones from
 * panes that no longer exist). Returns the number of partitions cleared.
 */
export async function clearAllWebViewerData (): Promise<number> {
    const names = listWebViewerPartitions()
    for (const name of names) {
        const ses = sessionFromPartition('persist:' + name)
        await ses.clearStorageData({
            storages: ['cachestorage', 'cookies', 'filesystem', 'indexdb',
                       'localstorage', 'serviceworkers', 'shadercache', 'websql'],
        }).catch(() => {})
        await ses.clearCache().catch(() => {})
    }
    return names.length
}

export function openInSystemBrowser (url: string): void {
    if (url) {
        shellOpenExternal(url)
    }
}
