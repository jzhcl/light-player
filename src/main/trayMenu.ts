// ============================================================
// Windows 自绘托盘菜单
//
// 自己定位到托盘图标旁边，靠失焦模拟「点别处关闭」。
// 只在 win32 启用（开关在 tray.ts），其余平台仍是原生 Menu。
// ============================================================

import { BrowserWindow, screen } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOPIC } from '@shared/topic'
import { publishToTopic, registerTopicWindow, unregisterTopicWindow } from './ipc/message'
import { attachInputHandlers, loadWindowPage } from './windows'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 菜单卡片与托盘图标之间的视觉间距 */
const TRAY_MENU_GAP = 6
/** 菜单卡片与屏幕工作区边缘的最小间距 */
const TRAY_MENU_SCREEN_MARGIN = 4
const TRAY_MENU_PAGE = 'tray-menu.html'

/** 卡片尺寸 */
const CARD_SIZE = { width: 200, height: 209 }

/** 卡片四周留给阴影的透明边 */
const SHADOW_INSET = 12

/** 窗口尺寸 = 卡片 + 两侧阴影边 */
const WINDOW_SIZE = {
    width: CARD_SIZE.width + SHADOW_INSET * 2,
    height: CARD_SIZE.height + SHADOW_INSET * 2,
}

/**
 * 屏外停放坐标 —— Windows 的经典哨兵值（不落任何显示器，DWM 不合成）。
 * 别改成「负虚拟屏坐标」：多显示器可以合法地占负坐标，那样会停到真屏幕上。
 */
const PARKED_POSITION = { x: -32000, y: -32000 } as const

let trayMenuWindow: BrowserWindow | null = null
/** 逻辑可见性 */
let trayMenuOnScreen = false
/** 是否已经走过一次真正的 `show()`：只有第一次需要切 OS 可见性 */
let trayMenuEverShown = false

function clamp(value: number, min: number, max: number): number {
    if (max < min) return min
    return Math.min(Math.max(value, min), max)
}

/** 把菜单窗停到屏幕外：窗口保持 OS「可见」，因此不触发系统的显示过渡 */
function parkWindow(win: BrowserWindow): void {
    const b = win.getBounds()
    if (win.isFocused()) win.blur()

    // hover 是渲染端的命中结果，只有指针事件才刷新它。窗口只是被挪走、从没 hide()，
    // 所以 `:hover` 会一直挂在按下的那个按钮上撑到指针下次真正移动，补一次「指针移到窗口外」的合成事件。
    if (!win.webContents.isDestroyed()) {
        const away = { x: b.width + 64, y: b.height + 64 }
        win.webContents.sendInputEvent({ type: 'mouseLeave', x: away.x, y: away.y })
        win.webContents.sendInputEvent({ type: 'mouseMove', x: away.x, y: away.y })
    }

    win.setBounds({ ...PARKED_POSITION, width: b.width, height: b.height })
}

/**
 * 创建菜单窗。托盘建好时就调一次，让页面在后台先加载完 ——
 * 首次右键才不会等到加载完才弹出。
 */
export function createTrayMenuWindow(): void {
    const win = new BrowserWindow({
        width: WINDOW_SIZE.width,
        height: WINDOW_SIZE.height,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    })

    trayMenuWindow = win
    win.setMenuBarVisibility(false)
    win.setAlwaysOnTop(true, 'pop-up-menu')

    // 登记为 topic 层的收件人：主进程按 `TOPIC.TRAY_MENU` 推状态快照
    registerTopicWindow(TOPIC.TRAY_MENU, win)

    // 无边框窗没有系统菜单那套「点别处自动关」，只能靠失焦模拟。
    // 收起走停放，而停放自己会 blur 一次 —— `hideTrayMenu` 靠逻辑位短路，不会递归。
    win.on('blur', () => hideTrayMenu())
    win.on('closed', () => {
        unregisterTopicWindow(TOPIC.TRAY_MENU)
        if (trayMenuWindow === win) trayMenuWindow = null
        trayMenuOnScreen = false
        trayMenuEverShown = false
    })
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') {
            event.preventDefault()
            hideTrayMenu()
        }
    })

    loadWindowPage(win, TRAY_MENU_PAGE)
    attachInputHandlers(win)
}

/** 交给渲染端的状态快照；窗口未加载完时丢弃，渲染端挂载后会主动拉取一次 */
export function pushTrayMenuState(state: TrayMenuState): void {
    const win = trayMenuWindow
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return
    publishToTopic(TOPIC.TRAY_MENU, 'trayMenuStateChanged', state)
}

export function isTrayMenuVisible(): boolean {
    return !!trayMenuWindow && !trayMenuWindow.isDestroyed() && trayMenuOnScreen
}

/**
 * 收起菜单：停到屏幕外。
 *
 * 先把逻辑位翻掉再动窗口 —— 停放时的 `blur()` 会派发 `blur` 事件，处理器据此短路。
 */
export function hideTrayMenu(): void {
    const win = trayMenuWindow
    if (!win || win.isDestroyed() || !trayMenuOnScreen) return

    trayMenuOnScreen = false
    parkWindow(win)
}

/** 右键托盘：已显示则关闭，否则定位并弹出 */
export function showTrayMenu(trayBounds: Electron.Rectangle): void {
    const win = trayMenuWindow
    if (!win || win.isDestroyed()) return

    if (trayMenuOnScreen) {
        hideTrayMenu()
        return
    }

    win.setBounds(computeTrayMenuBounds(trayBounds))

    // 只有第一次需要切 OS 可见性（那一次系统淡入就是入场动画）；
    // 之后窗口一直在「可见」状态，挪回屏幕内即可，没有过渡也没有闪烁。
    if (!trayMenuEverShown) {
        trayMenuEverShown = true
        win.show()
    }
    win.focus()
    trayMenuOnScreen = true
}

export function destroyTrayMenu(): void {
    trayMenuOnScreen = false
    trayMenuEverShown = false
    if (!trayMenuWindow) return
    if (!trayMenuWindow.isDestroyed()) trayMenuWindow.destroy()
    trayMenuWindow = null
}

/**
 * 依据托盘图标所在屏幕边缘决定弹出方向，并把窗口夹在工作区内。
 * 托盘图标可能落在任务栏上（工作区之外），也可能因任务栏自动隐藏而位于工作区内，
 * 因此统一按「图标中心离工作区哪条边最近」来判断。
 */
function computeTrayMenuBounds(trayBounds: Electron.Rectangle): Electron.Rectangle {
    const trayCx = trayBounds.x + trayBounds.width / 2
    const trayCy = trayBounds.y + trayBounds.height / 2
    const display = screen.getDisplayNearestPoint({
        x: Math.round(trayCx),
        y: Math.round(trayCy),
    })
    const area = display.workArea
    // 夹的是卡片：那圈阴影边挤出屏幕无所谓，卡片必须完整可见
    const { width, height } = CARD_SIZE

    const distances = [
        Math.abs(trayCy - area.y),
        Math.abs(trayCy - (area.y + area.height)),
        Math.abs(trayCx - area.x),
        Math.abs(trayCx - (area.x + area.width)),
    ]
    const side = ['top', 'bottom', 'left', 'right'][
        distances.indexOf(Math.min(...distances))
    ] as 'top' | 'bottom' | 'left' | 'right'

    let x = Math.round(trayCx - width / 2)
    let y = Math.round(trayCy - height / 2)

    switch (side) {
        case 'top':
            y = trayBounds.y + trayBounds.height + TRAY_MENU_GAP
            break
        case 'bottom':
            y = trayBounds.y - TRAY_MENU_GAP - height
            break
        case 'left':
            x = trayBounds.x + trayBounds.width + TRAY_MENU_GAP
            break
        case 'right':
            x = trayBounds.x - TRAY_MENU_GAP - width
            break
    }

    x = clamp(x, area.x + TRAY_MENU_SCREEN_MARGIN, area.x + area.width - width - TRAY_MENU_SCREEN_MARGIN)
    y = clamp(y, area.y + TRAY_MENU_SCREEN_MARGIN, area.y + area.height - height - TRAY_MENU_SCREEN_MARGIN)

    // 卡片坐标 → 窗口坐标：往外扩出阴影边
    return {
        x: x - SHADOW_INSET,
        y: y - SHADOW_INSET,
        width: WINDOW_SIZE.width,
        height: WINDOW_SIZE.height,
    }
}
