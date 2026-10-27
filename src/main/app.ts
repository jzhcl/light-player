import { app, BrowserWindow, dialog } from 'electron'
import type { Tray } from 'electron'
import {
    closeLyricWindow,
    createMainWindow,
    setLyricStateHandler,
    setMainWindowCloseHandler,
} from './windows'
import { createTray, destroyTray, syncLyricVisible } from './tray'
import { registerIpcHandlers } from './ipc'
import { initDatabase } from './db'
import { getSetting, initSettings } from './settings'
import { initPluginHost } from './plugin/host'
import { getUpdateState, initUpdater, isUpdaterQuitting } from './updater'
import { downloadManager } from './download'
import { ensureAppDirectories } from '@main/constants/paths'
import { LP_EVENT } from '@shared/event'
import { unregisterAllShortcut } from './hotkey'
import { log } from './log'

export interface AppContext {
    mainWindow: BrowserWindow | null
    tray: Tray | null
}

/** 运行时长 → `1h23m` / `2m05s` / `45s` */
function formatElapsed(ms: number): string {
    const total = Math.round(ms / 1000)
    if (total < 60) return `${total}s`
    const minutes = Math.floor(total / 60)
    if (minutes < 60) return `${minutes}m${String(total % 60).padStart(2, '0')}s`
    return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

/** 显示主窗并聚焦；已最小化时先还原。 */
export function showMainWindow(ctx: AppContext): void {
    const w = ctx.mainWindow
    if (!w || w.isDestroyed()) return
    if (w.isMinimized()) w.restore()
    w.show()
    w.focus()
}

function createContext(): AppContext {
    return { mainWindow: null, tray: null }
}

// ============================================================
// 退出流程
// ============================================================

/** 退出流程是否已启动（重入守卫：连点 ✕ / 等待用户确认期间再触发都要忽略） */
let closing = false

/**
 * 「请求关闭」：按设置决定是隐藏到托盘，还是走退出流程。
 */
export function requestClose(ctx: AppContext): void {
    if (closing) return
    const w = ctx.mainWindow
    if (!w || w.isDestroyed()) return
    if (getSetting('window.closeToTray')) {
        w.hide()
        return
    }
    void beginQuit(ctx)
}

/**
 * 「请求退出」：托盘菜单「退出」等明确要求退出的入口走这条。
 * 与 requestClose 的区别是不看 `window.closeToTray`。
 */
export function requestQuit(ctx: AppContext): void {
    if (closing) return
    void beginQuit(ctx)
}

/**
 * 退出流程：
 *
 * 1. 有未完成的下载任务时弹原生确认框；用户选「继续下载」→ 整轮回滚（复位 `closing`，窗口照旧）；
 * 2. 确认后：记录标 `cancelled` → 取消这些任务 → 销毁歌词窗与托盘；
 * 3. 关主窗 → `window-all-closed` → `app.quit()`。
 *
 * ⚠️ 判据用**任务仓库**（`listUnfinished()`）而不是 `download_records` 表：表里会残留
 * 强杀留下的孤儿未完成记录，按表判会给用户弹一个「根本没有任务」的假确认框。
 * ⚠️ 用 `w.close()` 而不是 `destroy()`：正常关闭流程才会触发渲染端 `beforeunload` /
 * `pagehide` 的落盘钩子（`settingsStore` 的防抖落盘靠它兜）。
 */
async function beginQuit(ctx: AppContext): Promise<void> {
    if (closing) return
    closing = true

    const pendingIds = downloadManager.listUnfinished().map((t) => t.id)
    // 更新下载挂在 electron-updater 里，不在 downloadManager —— 得单独看
    const updateDownloading = getUpdateState().status === 'downloading'

    if (pendingIds.length > 0 || updateDownloading) {
        // 退出是唯一会批量取消下载的路径 —— 取消了多少必须有痕
        log.info(
            `[life] 退出：${pendingIds.length} 个未完成下载任务` +
                (updateDownloading ? '，且更新正在下载' : ''),
        )
        if (!(await confirmQuit(ctx, pendingIds.length, updateDownloading))) {
            log.info('[life] 退出已取消（用户选择继续下载）')
            closing = false
            return
        }
    }

    downloadManager.markRecordsCancelled(pendingIds)
    downloadManager.cancelAllPending()

    closeLyricWindow()
    destroyTray()
    ctx.tray = null

    const w = ctx.mainWindow
    if (!w || w.isDestroyed()) {
        app.quit()
        return
    }
    w.close()
}

/**
 * 退出确认。返回 true = 「仍然退出」。
 */
async function confirmQuit(ctx: AppContext, taskCount: number, updateDownloading: boolean): Promise<boolean> {
    const win = ctx.mainWindow
    const parent = win && !win.isDestroyed() ? win : null
    if (parent && !parent.isVisible()) showMainWindow(ctx)

    const lines: string[] = []
    if (taskCount > 0) lines.push(`还有 ${taskCount} 个下载任务未完成`)
    if (updateDownloading) lines.push('新版本正在下载')

    const details: string[] = []
    if (taskCount > 0) details.push('退出后这些下载会被取消，已下载的部分不会保留。')
    if (updateDownloading) details.push('退出会中断更新下载，下次启动会重新检查。')

    const options: Electron.MessageBoxOptions = {
        type: 'warning',
        title: '还有未完成的操作',
        message: lines.join('\n'),
        detail: details.join('\n'),
        buttons: ['仍然退出', '继续下载'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
    }

    try {
        const { response } = parent
            ? await dialog.showMessageBox(parent, options)
            : await dialog.showMessageBox(options)
        return response === 0
    } catch {
        // 弹不出来不等于「用户想留下」—— 用户的意图是退出，按继续退出处理
        return true
    }
}

export function bootstrap(): AppContext {
    const ctx = createContext()
    const startedAt = Date.now()

    // 会话起点
    log.info(
        `[life] 启动 v${app.getVersion()} · electron ${process.versions.electron} · ${app.isPackaged ? 'prod' : 'dev'}`,
    )

    // 单实例锁
    if (!app.requestSingleInstanceLock()) {
        app.quit()
        return ctx
    }
    app.on('second-instance', () => showMainWindow(ctx))

    app.whenReady().then(() => {
        ensureAppDirectories()
        initDatabase()
        initSettings()
        initPluginHost()

        // 歌词窗开/关：刷新托盘文案 + 广播给主窗渲染端（按钮态 / 同步门控）。
        setLyricStateHandler((open) => {
            syncLyricVisible(open)
            const main = ctx.mainWindow
            if (main && !main.isDestroyed()) {
                main.webContents.send(LP_EVENT['DESKTOP_LYRIC.STATE'], open)
            }
        })

        // 主窗关闭请求统一走 requestClose；返回 true = 拦截默认关闭。
        // ⚠️ Alt+F4 / 任务栏关闭 / 页面 `window.close()` 都不经过
        // 渲染端 ✕ 与托盘，只会在 `close` 事件这里出现 —— 不拦就不取消下载、也不销毁歌词窗。
        setMainWindowCloseHandler(() => {
            if (closing) return false
            // 放行更新安装
            if (isUpdaterQuitting()) return false
            requestClose(ctx)
            return true
        })

        ctx.mainWindow = createMainWindow()
        ctx.tray = createTray(ctx)

        registerIpcHandlers(ctx)

        initUpdater(ctx)
    })

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit()
    })

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            ctx.mainWindow = createMainWindow()
        }
    })

    // 退出前注销全部全局快捷键
    app.on('will-quit', () => {
        unregisterAllShortcut()
        log.info(`[life] 退出（运行 ${formatElapsed(Date.now() - startedAt)}）`)
    })

    return ctx
}
