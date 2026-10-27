import { ipcMain } from 'electron'
import type { AppContext } from '../app'
import { getTrayMenuState, updateTrayState } from '../tray'
import { hideTrayMenu } from '../trayMenu'

// 托盘状态上报 + 自绘托盘菜单的窗口管理
export function registerTrayHandlers(_ctx: AppContext): void {
    ipcMain.handle('tray:updateState', (_e, patch: Partial<TrayMenuState>) => {
        updateTrayState(patch)
        return true
    })

    // 菜单窗挂载时主动拉一次快照：状态推送可能早于页面加载完成
    ipcMain.handle('trayMenuWindow:getState', () => getTrayMenuState())

    // 菜单里的「显示/关闭桌面歌词」由主窗执行，收起菜单是主进程的事
    ipcMain.handle('trayMenuWindow:hide', () => {
        hideTrayMenu()
        return true
    })
}
