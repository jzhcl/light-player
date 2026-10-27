import { ipcMain } from 'electron'
import { fail, ok } from '@shared/result'
import { checkForUpdates, downloadUpdate, fetchChangelog, getUpdateState, installUpdate } from '@main/updater'
import type { AppContext } from '@main/app'

/** 自动更新的动词 */
export function registerUpdateHandlers(_ctx: AppContext): void {
    ipcMain.handle('update:getState', () => {
        try {
            return ok(getUpdateState())
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('update:check', async () => {
        try {
            await checkForUpdates()
            return ok(null)
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('update:download', async () => {
        try {
            await downloadUpdate()
            return ok(null)
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('update:install', () => {
        try {
            installUpdate()
            return ok(null)
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    /**
     * 更新日志：返回 fromVersion 之后的版本说明。
     * - fromVersion 传 null：只要最新一版
     * - inclusive=true：把 fromVersion 自己那条也算进来
     */
    ipcMain.handle('update:getChangelog', async (_e, fromVersion: string | null, inclusive = false) => {
        try {
            return ok(await fetchChangelog(fromVersion, inclusive))
        } catch (err) {
            return fail((err as Error).message)
        }
    })
}
