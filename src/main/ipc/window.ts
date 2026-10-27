import { ipcMain } from 'electron'
import type { AppContext } from '../app'
import { requestClose, showMainWindow } from '../app'
import {
    toggleLyricWindow,
    closeLyricWindow,
    setLyricWindowDraggable,
    setLyricWindowMouseThrough,
    startLyricResize,
    stopLyricResize,
} from '../windows'
import type { ResizeDirection } from '../utils/draggable'

// 窗口控制
export function registerWindowHandlers(ctx: AppContext): void {
    ipcMain.handle('mainWindow:show', () => {
        showMainWindow(ctx)
        return true
    })

    ipcMain.handle('mainWindow:toggleShow', () => {
        const w = ctx.mainWindow
        if (!w) {
            return false
        }
        if (w.isVisible()) w.hide()
        else showMainWindow(ctx)
        return true
    })

    ipcMain.handle('mainWindow:hide', () => {
        ctx.mainWindow?.hide()
        return true
    })

    ipcMain.handle('mainWindow:minimize', () => {
        ctx.mainWindow?.minimize()
        return true
    })

    // 切换桌面歌词窗显隐。歌词窗惰性创建：首次显示时才建窗。
    ipcMain.handle('mainWindow:toggleLyric', () => {
        toggleLyricWindow()
        return true
    })

    // 关闭桌面歌词窗
    ipcMain.handle('mainWindow:closeLyric', () => {
        closeLyricWindow()
        return true
    })

    // 桌面歌词窗：开关整窗拖拽。
    ipcMain.handle('desktopLyricWindow:setDraggable', (_e, enabled: boolean) => {
        setLyricWindowDraggable(enabled)
        return true
    })

    // 桌面歌词窗：开关鼠标穿透。
    ipcMain.handle('desktopLyricWindow:setMouseThrough', (_e, enable: boolean) => {
        setLyricWindowMouseThrough(enable)
        return true
    })

    // 桌面歌词窗：缩放。渲染端在缩放区按下时进入，松手时退出。
    ipcMain.handle('desktopLyricWindow:startResize', (_e, direction: ResizeDirection) => {
        startLyricResize(direction)
        return true
    })

    ipcMain.handle('desktopLyricWindow:stopResize', () => {
        stopLyricResize()
        return true
    })

    // 关闭（请求关闭）：隐藏到托盘还是退出、以及退出的收尾顺序，统一由 app 层决策。
    ipcMain.handle('mainWindow:close', () => {
        requestClose(ctx)
        return true
    })

    // 调整主窗尺寸，展开导航栏且窗口过窄时由渲染端调用，避免内容被挤压。
    ipcMain.handle('mainWindow:setWindowSize', (_e, size: { width?: number; height?: number }) => {
        const w = ctx.mainWindow
        if (!w) {
            return false
        }
        const bounds = w.getBounds()
        w.setBounds({
            x: bounds.x,
            y: bounds.y,
            width: size.width ?? bounds.width,
            height: size.height ?? bounds.height,
        })
        return true
    })

    // 打开主窗口开发者工具
    ipcMain.handle('mainWindow:openDevTools', () => {
        ctx.mainWindow?.webContents.openDevTools({ mode: 'detach' })
        return true
    })
}
