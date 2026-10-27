import { dialog, ipcMain, shell } from 'electron'
import { failWithLog, ok } from '@shared/result'
import {
    copyFile,
    createFile,
    deleteDirectory,
    deleteFile,
    ensureDir,
    getDirectoryFiles,
    getFileInfo,
    isFileExist,
    isFileExistAsync,
    moveFile,
    readFile,
    writeFile
} from '../file'
import type { FileEncoding, FileSelectionOptions } from '@shared/types/file'
import type { AppContext } from '@main/app'
import { log } from '@main/log'

const fileFail = (op: string, detail: string, err: unknown) =>
    failWithLog(log, 'file', op, detail, err)

export function registerFileHandlers(ctx: AppContext): void {
    ipcMain.handle('file:read', (_e, path: string, encoding?: FileEncoding) => {
        try {
            return ok(readFile(path, encoding))
        } catch (err) {
            return fileFail('read', `path: ${path}`, err)
        }
    })

    ipcMain.handle('file:write', (_e, path: string, content: string | Uint8Array, encoding?: FileEncoding) => {
        try {
            writeFile(path, content, encoding)
            return ok(true)
        } catch (err) {
            return fileFail('write', `path: ${path}`, err)
        }
    })

    ipcMain.handle('file:create', (_e, path: string, content?: string | Uint8Array, encoding?: FileEncoding) => {
        try {
            createFile(path, content, encoding)
            return ok(true)
        } catch (err) {
            return fileFail('create', `path: ${path}`, err)
        }
    })

    ipcMain.handle('file:delete', (_e, path: string) => {
        try {
            deleteFile(path)
            return ok(true)
        } catch (err) {
            return fileFail('delete', `path: ${path}`, err)
        }
    })

    ipcMain.handle('file:deleteDirectory', (_e, dir: string) => {
        try {
            deleteDirectory(dir)
            return ok(true)
        } catch (err) {
            return fileFail('deleteDirectory', `dir: ${dir}`, err)
        }
    })

    ipcMain.handle('file:copy', (_e, src: string, dest: string) => {
        try {
            copyFile(src, dest)
            return ok(true)
        } catch (err) {
            return fileFail('copy', `src: ${src}\ndest: ${dest}`, err)
        }
    })

    ipcMain.handle('file:move', (_e, src: string, dest: string) => {
        try {
            moveFile(src, dest)
            return ok(true)
        } catch (err) {
            return fileFail('move', `src: ${src}\ndest: ${dest}`, err)
        }
    })

    ipcMain.handle('file:ensureDir', (_e, dir: string) => {
        try {
            ensureDir(dir)
            return ok(true)
        } catch (err) {
            return fileFail('ensureDir', `dir: ${dir}`, err)
        }
    })

    ipcMain.handle('file:listDir', (_e, dir: string) => {
        try {
            return ok(getDirectoryFiles(dir))
        } catch (err) {
            return fileFail('listDir', `dir: ${dir}`, err)
        }
    })


    ipcMain.handle('file:exists', (_e, path: string) => isFileExist(path))

    // 批量存在性探测
    ipcMain.handle('file:existsMany', async (_e, paths: string[]) =>
        Array.isArray(paths) ? await Promise.all(paths.map((p) => isFileExistAsync(p))) : [],
    )


    ipcMain.handle('file:getInfo', (_e, path: string) => getFileInfo(path))

    ipcMain.handle('file:selectFile', async (_e, options: FileSelectionOptions = {}) => {
        const win = ctx.mainWindow
        const result = await dialog.showOpenDialog(win!, {
            properties: ['openFile'],
            title: options.title ?? '选择文件',
            defaultPath: options.defaultPath,
            filters: options.filters ?? [{ name: '所有文件', extensions: ['*'] }],
        })
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
    })

    ipcMain.handle('file:selectFiles', async (_e, options: FileSelectionOptions = {}) => {
        const win = ctx.mainWindow
        const result = await dialog.showOpenDialog(win!, {
            properties: ['openFile', 'multiSelections'],
            title: options.title ?? '选择文件',
            defaultPath: options.defaultPath,
            filters: options.filters ?? [{ name: '所有文件', extensions: ['*'] }],
        })
        if (result.canceled) return []
        return result.filePaths
    })

    ipcMain.handle('file:selectDirectory', async (_e, options: FileSelectionOptions = {}) => {
        const win = ctx.mainWindow
        const result = await dialog.showOpenDialog(win!, {
            properties: ['openDirectory'],
            title: options.title ?? '选择目录',
            defaultPath: options.defaultPath,
        })
        if (result.canceled || result.filePaths.length === 0) return null
        return result.filePaths[0]
    })

    // 资源管理器定位/打开
    ipcMain.handle('file:showItemInFolder', (_e, path: string) => {
        shell.showItemInFolder(path)
    })

    // 返回打开结果
    ipcMain.handle('file:openDirInExplorer', async (_e, dir: string) => {
        const err = await shell.openPath(dir)
        if (err) log.warn(`[file] 打开目录失败\n dir: ${dir}\n${err}`)
        return err
    })
}
