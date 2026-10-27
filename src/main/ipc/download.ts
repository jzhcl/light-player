import { ipcMain } from 'electron'
import { dirname } from 'node:path'
import { fail, ok } from '@shared/result'
import { downloadManager, type NewDownloadTask } from '../download'
import { createFile, ensureDir } from '@main/file'
import type { AppContext } from '../app'


export function registerDownloadHandlers(ctx: AppContext): void {
    // 事件推送：manager 三个事件（started/completed/failed）经主窗口 webContents.send 转发。
    downloadManager.setEmitter((channel, payload) => {
        ctx.mainWindow?.webContents.send(channel, payload)
    })

    ipcMain.handle('download:add', async (e, task: NewDownloadTask) => {
        try {
            const win = ctx.mainWindow
            if (!win) throw new Error('找不到主窗口')
            return ok(downloadManager.add(task, win))
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    // 批量提交
    ipcMain.handle('download:addBatch', async (_e, tasks: NewDownloadTask[]) => {
        try {
            const win = ctx.mainWindow
            if (!win) throw new Error('找不到主窗口')
            return ok(downloadManager.addBatch(tasks, win))
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('download:pause', (_e, id: string) => {
        try {
            return ok(downloadManager.pause(id))
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('download:resume', (_e, id: string) => {
        try {
            return ok(downloadManager.resume(id))
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('download:remove', (_e, id: string) => {
        try {
            return ok(downloadManager.remove(id))
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('download:list', () => {
        try {
            return ok(downloadManager.list())
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('download:downloadImage', async (_e, url: string, savePath: string) => {
        try {
            const res = await fetch(url)
            if (!res.ok) return ok(false)
            const buf = Buffer.from(await res.arrayBuffer())
            ensureDir(dirname(savePath))
            createFile(savePath, buf)
            return ok(true)
        } catch (err) {
            return ok(false)
        }
    })
}
