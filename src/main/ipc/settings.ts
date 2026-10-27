import { ipcMain } from 'electron'
import { fail, ok } from '@shared/result'
import { getSetting, setSetting, type MainSettingKey } from '../settings'
import { applyBackgroundMaterial } from '../windows'
import type { AppContext } from '../app'


export function registerSettingsHandlers(ctx: AppContext): void {
    // 读取单个设置
    ipcMain.handle('settings:get', (_e, key: MainSettingKey) => {
        try {
            return ok(getSetting(key))
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    // 写入单个设置
    ipcMain.handle('settings:set', (_e, key: MainSettingKey, value: LP.MainSetting[MainSettingKey]) => {
        try {
            setSetting(key, value)
            // 背景材质是「写库后需立即作用于窗口」的设置，单独补一次套用
            if (key === 'window.backgroundMaterial') applyBackgroundMaterial(ctx.mainWindow)
            return ok(true)
        } catch (err) {
            return fail((err as Error).message)
        }
    })
}
