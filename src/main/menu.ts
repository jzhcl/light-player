/**
 * macOS 应用菜单。
 *
 * 1. ⌘C / ⌘V / ⌘A / ⌘Z 在输入框里能用，全靠 Edit 那组 role —— Chromium 在 mac 上
 *    不自己处理剪贴板快捷键，只认菜单 role；
 * 2. ⌘Q 走这里 → `requestQuit`，和托盘「退出」收敛到同一条退出流程
 *    （否则默认菜单的 `role: quit` 会直接 app.quit()，被关窗拦截后变成「只藏窗口」）；
 * 3. 不再提供 Reload / Toggle DevTools —— F12（`application.debug.enable` 开启时）
 *    是开发者工具的唯一入口，避免用户误按 ⌘R 把播放状态整个刷掉。
 *
 * 设置页（⌘,）暂未接：渲染端是 HashRouter，主进程没有「导航到某路由」的通道，
 * 等有了再补，别在这里硬塞 webContents.executeJavaScript。
 */
import { Menu } from 'electron'
import type { AppContext } from './app'
import { requestQuit } from './app'

/** 菜单栏标题 */
const APP_NAME = 'LightPlayer'

/** 安装应用菜单（仅 macOS；其他平台直接返回，保留 Electron 默认行为） */
export function installApplicationMenu(ctx: AppContext): void {
    if (process.platform !== 'darwin') return

    const template: Electron.MenuItemConstructorOptions[] = [
        {
            label: APP_NAME,
            submenu: [
                { role: 'about', label: `关于 ${APP_NAME}` },
                { type: 'separator' },
                { role: 'hide', label: `隐藏 ${APP_NAME}` },
                { role: 'hideOthers', label: '隐藏其他' },
                { role: 'unhide', label: '全部显示' },
                { type: 'separator' },
                // 不用 role: quit —— 那样会绕过取消下载 / 确认框 / 销毁托盘
                { label: `退出 ${APP_NAME}`, accelerator: 'Command+Q', click: () => requestQuit(ctx) },
            ],
        },
        {
            label: '编辑',
            submenu: [
                { role: 'undo', label: '撤销' },
                { role: 'redo', label: '重做' },
                { type: 'separator' },
                { role: 'cut', label: '剪切' },
                { role: 'copy', label: '复制' },
                { role: 'paste', label: '粘贴' },
                { role: 'selectAll', label: '全选' },
            ],
        },
        {
            label: '窗口',
            submenu: [
                { role: 'close', label: '关闭窗口' },
                { role: 'minimize', label: '最小化' },
                // 对应绿钮的 zoom（铺满工作区），不是原生全屏 —— 见 windows.ts 的 setFullScreenable(false)
                { role: 'zoom', label: '缩放' },
                { type: 'separator' },
                { role: 'front', label: '前置全部窗口' },
            ],
        },
    ]

    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
