import { ipcMain } from 'electron'
import { rInfo, rDebug, rWarn, rError, rVerbose } from '../log'
import type { AppContext } from '../app'


export function registerLogHandlers(_ctx: AppContext): void {
    ipcMain.handle('logInfo', (_e, ...params: unknown[]) => {
        rInfo(...params)
    })
    ipcMain.handle('logError', (_e, ...params: unknown[]) => {
        rError(...params)
    })
    ipcMain.handle('logWarn', (_e, ...params: unknown[]) => {
        rWarn(...params)
    })
    ipcMain.handle('logDebug', (_e, ...params: unknown[]) => {
        rDebug(...params)
    })
    ipcMain.handle('logVerbose', (_e, ...params: unknown[]) => {
        rVerbose(...params)
    })
}
