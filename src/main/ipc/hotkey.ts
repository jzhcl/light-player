import { ipcMain } from 'electron'
import type { AppContext } from '../app'
import { fail, ok } from '@shared/result'
import {
    disableMediaKeys,
    enableMediaKeys,
    isMediaKeysRegistered,
    isRegisteredShortcut,
    registerShortcut,
    unregisterAllShortcut
} from '../hotkey'


export function registerHotkeyHandlers(ctx: AppContext): void {
    ipcMain.handle('hotkey:register', (_e, action: string, data: { origin: string; target: string }) => {
        try {
            const win = ctx.mainWindow
            if (!win) throw new Error('找不到主窗口')
            registerShortcut(win, action, data)
            return ok(true)
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('hotkey:isRegistered', (_e, accelerator: string) => {
        return isRegisteredShortcut(accelerator)
    })

    ipcMain.handle('hotkey:unregisterAll', () => {
        unregisterAllShortcut()
        return true
    })

    ipcMain.handle('hotkey:enableMediaKeys', () => {
        try {
            const win = ctx.mainWindow
            if (!win) throw new Error('找不到主窗口')
            enableMediaKeys(win)
            return ok(true)
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('hotkey:disableMediaKeys', () => {
        try {
            disableMediaKeys()
            return ok(true)
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle('hotkey:isMediaKeysRegistered', () => {
        return isMediaKeysRegistered()
    })
}
