import { app, ipcMain, shell } from 'electron'
import type { AppContext } from '@main/app'
import { requestQuit } from '@main/app'
import { isSafeExternalUrl } from '@shared/utils'
import { fail, ok } from '@shared/result'

export function registerAppHandlers(ctx: AppContext): void {
    ipcMain.handle('app:getVersion', () => app.getVersion())

    ipcMain.handle('app:getPathMaterial', () => ({
        userData: app.getPath('userData'),
        home: app.getPath('home'),
        downloads: app.getPath('downloads'),
    }))

    // 用系统默认浏览器打开外部链接，不在 Electron 内新开窗口
    ipcMain.handle('app:openExternal', async (_e, url: string) => {
        if (!isSafeExternalUrl(url)) {
            return fail('仅允许打开 http/https 链接')
        }
        try {
            await shell.openExternal(url)
            return ok(true)
        } catch (err) {
            return fail(err instanceof Error ? err.message : String(err))
        }
    })

    // 明确要求退出（托盘菜单「退出」）
    ipcMain.handle('app:quit', () => {
        requestQuit(ctx)
        return true
    })
}
