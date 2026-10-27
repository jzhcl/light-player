import { BrowserWindow, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { getSetting, setSetting } from './settings'
import { registerTopicWindow, unregisterTopicWindow } from './ipc/message'
import { makeWindowFullyDraggable, type DragController, type ResizeDirection } from './utils/draggable'
import { PATHS } from '@main/constants/paths'
import { TOPIC } from '@shared/topic'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const devServerUrl = process.env.VITE_DEV_SERVER_URL
const isDev = !!devServerUrl

/** 窗口 bounds 设置键（值形如 LP.MainSetting 中的 bounds 结构）。 */
export type BoundsKey = 'mainWindow.bounds' | 'desktopLyricWindow.bounds'

/**
 * 读取指定窗口的持久化 bounds，把 x/y 的 'center' 解析为主显示器工作区内的实际坐标
 */
function resolveBounds(key: BoundsKey): { width: number; height: number; x: number; y: number } {
    const bounds = getSetting(key)
    const { width, height } = bounds
    const area = screen.getPrimaryDisplay().workArea

    const x = bounds.x === 'center' ? Math.floor((area.width - width) / 2) : bounds.x
    const y = bounds.y === 'center' ? Math.floor((area.height - height) / 2) : bounds.y

    return { width, height, x, y }
}

/**
 * 把持久化 bounds 套用到窗口
 */
function applyBounds(win: BrowserWindow, key: BoundsKey): void {
    const { width, height, x, y } = resolveBounds(key)
    win.setSize(width, height)
    win.setPosition(x, y)
}

/**
 * 把窗口当前 bounds 写回设置。窗口已销毁时静默跳过
 */
export function saveBounds(win: BrowserWindow | null, key: BoundsKey): void {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    setSetting(key, { width: b.width, height: b.height, x: b.x, y: b.y })
}

// ============================================================
// 两窗共用的窗口行为
// ============================================================

/** 加载渲染端页面：dev 指向 dev server，prod 读 dist 里的产物 */
export function loadWindowPage(win: BrowserWindow, page: string): void {
    if (isDev) {
        win.loadURL(`${devServerUrl}${page}`).catch(() => {})
    } else {
        win.loadFile(join(__dirname, '..', page)).catch(() => {})
    }
}

/**
 * 拦截键盘：禁用 F11 全屏；debug 开启时 F12 打开本窗开发者工具（独立窗口）。
 * 用 `before-input-event` 而非渲染端监听，键盘不经过页面即可拦下，也不受页面焦点影响。
 */
export function attachInputHandlers(win: BrowserWindow): void {
    const debugEnabled = () => getSetting('application.debug.enable')

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return

        // 禁止 F11 全屏
        if (input.key === 'F11') {
            event.preventDefault()
            return
        }

        // F12 开发者工具：仅 debug 开启时响应；每窗各自独立窗口打开
        if (input.key === 'F12' && debugEnabled()) {
            const wc = win.webContents
            if (wc.isDevToolsOpened()) {
                // 已开则聚焦既有窗口，避免重复创建
                wc.devToolsWebContents?.focus()
            } else {
                wc.openDevTools({ mode: 'detach' })
            }
            event.preventDefault()
        }
    })
}

/**
 * 套用窗口背景材质（仅 Windows 支持）。不支持的平台静默跳过
 */
export function applyBackgroundMaterial(win: BrowserWindow | null): void {
    if (!win || process.platform !== 'win32' || win.isDestroyed()) return
    const material = getSetting('window.backgroundMaterial')
    try {
        win.setBackgroundMaterial(material)
    } catch (err) {
    }
}

/**
 * 阻断 `app-region: drag` 区域的右键原生菜单
 */
function blockDragAreaContextMenu(win: BrowserWindow): void {
    if (process.platform !== 'win32') return
    win.hookWindowMessage(0x0116, () => {
        setImmediate(() => {
            win.setEnabled(false)
            setTimeout(() => {
                win.setEnabled(true)
            }, 100)
        })
        return true
    })
}

// ============================================================
// 主窗
// ============================================================

function baseOptions(): Electron.BrowserWindowConstructorOptions {
    return {
        width: 1100,
        height: 800,
        minWidth: 900,
        minHeight: 720,
        show: false,
        frame: false,
        maximizable: false, // 应用不允许最大化，标题栏也不提供该入口
        icon: join(PATHS.getStatic(), 'images', 'logo-icon-round.png'),
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: false,
        },
    }
}

/**
 * 主窗「关闭请求」处理器，由 app 层注入（返回 true = 拦截本次默认关闭）。
 *
 * 关闭来源有三条 —— 渲染端标题栏 ✕（经 IPC）、Alt+F4 / 任务栏关闭（原生 `close`）、
 * 托盘菜单「退出」（直接调 app 层），三条都收敛到 app 层的同一个决策点。
 */
let onMainWindowClose: (() => boolean) | null = null

/** 注册主窗关闭请求处理器（在 bootstrap 中调用一次）。 */
export function setMainWindowCloseHandler(handler: () => boolean): void {
    onMainWindowClose = handler
}

export function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow(baseOptions())

    // 登记为 topic 层的收件人
    registerTopicWindow(TOPIC.MAIN, win)
    win.on('closed', () => unregisterTopicWindow(TOPIC.MAIN))

    // 恢复上次的位置与尺寸
    applyBounds(win, 'mainWindow.bounds')

    // 套用背景材质
    applyBackgroundMaterial(win)

    loadWindowPage(win, 'index.html')
    win.once('ready-to-show', () => win.show())

    win.on('close', (e) => {
        saveBounds(win, 'mainWindow.bounds')
        if (onMainWindowClose?.()) e.preventDefault()
    })
    win.on('hide', () => saveBounds(win, 'mainWindow.bounds'))

    attachInputHandlers(win)
    blockDragAreaContextMenu(win)

    return win
}

// ============================================================
// 桌面歌词窗（惰性创建 + 关闭即销毁）
// ============================================================

/** 当前歌词窗实例（惰性创建，销毁后置 null）。 */
let lyricWindow: BrowserWindow | null = null

/** 歌词窗的整窗拖拽控制器（与窗口同生命周期）。 */
let lyricDrag: DragController | null = null

/** 歌词窗「开了 / 关了」的回调，由 app 层注入 */
let onLyricStateChanged: ((open: boolean) => void) | null = null

/** 桌面歌词独立窗（透明、置顶、无边框、不进任务栏） */
function createLyricWindow(): BrowserWindow {
    const win = new BrowserWindow({
        ...baseOptions(),
        width: 1000,
        height: 300,
        minWidth: 200,
        minHeight: 100,
        transparent: true,
        skipTaskbar: true,
    })

    // 登记为 topic 层的收件人
    registerTopicWindow(TOPIC.LYRIC, win)
    win.on('closed', () => {
        unregisterTopicWindow(TOPIC.LYRIC)
        lyricDrag = null
    })

    // 整窗可拖
    lyricDrag = makeWindowFullyDraggable(win)

    // 恢复上次的位置与尺寸
    applyBounds(win, 'desktopLyricWindow.bounds')

    // 置顶层级取 'pop-up-menu'：高于普通置顶窗，但不抢占全屏应用/系统弹窗的层级
    win.setAlwaysOnTop(true, 'pop-up-menu')

    attachInputHandlers(win)
    blockDragAreaContextMenu(win)

    loadWindowPage(win, 'lyric.html')
    return win
}

/** 注册歌词窗开/关回调（在 bootstrap 中调用一次） */
export function setLyricStateHandler(handler: (open: boolean) => void): void {
    onLyricStateChanged = handler
}

/** 显示歌词窗：每次都建一个全新窗口 */
export function openLyricWindow(): void {
    if (lyricWindow && !lyricWindow.isDestroyed()) return

    const win = createLyricWindow()
    lyricWindow = win

    let shown = false
    const showOnce = (): void => {
        if (shown || win.isDestroyed()) return
        shown = true
        win.show()
    }
    // 首帧画完再 show，兜底 400ms
    win.once('ready-to-show', showOnce)
    const fallback = setTimeout(showOnce, 400)

    // 关闭边只认 `closed`：外部关闭（Alt+F4 等）也走这里，状态不会漏
    win.on('closed', () => {
        clearTimeout(fallback)
        // 已被新窗口接管（关→开连点）时直接返回：别把新引用抹掉、也别上报旧状态
        if (lyricWindow !== win) return
        lyricWindow = null
        onLyricStateChanged?.(false)
    })

    onLyricStateChanged?.(true)
}

/** 关闭歌词窗（销毁；下次显示是全新窗口，见 openLyricWindow）。关闭边由 `closed` 统一上报 */
export function closeLyricWindow(): void {
    const w = lyricWindow
    if (!w || w.isDestroyed()) return
    saveBounds(w, 'desktopLyricWindow.bounds')
    // 引用置空与状态上报都在 `closed` 回调里（见 openLyricWindow），这里只负责销毁
    w.destroy()
}

/** 歌词窗当前是否开着 */
function isLyricWindowVisible(): boolean {
    return !!lyricWindow && !lyricWindow.isDestroyed()
}

/**
 * 开关歌词窗的整窗拖拽
 */
export function setLyricWindowDraggable(enabled: boolean): void {
    lyricDrag?.setEnabled(enabled)
}

/**
 * 开关歌词窗的鼠标穿透。
 *
 * `forward: true` 是这套联动能自恢复的关键：窗口整体不接收鼠标之后，
 * 系统仍把鼠标移动转发给页面，页面才能判断指针回到了歌词上、把穿透关掉。
 * 少了 forward，一旦穿透就再也收不到任何鼠标事件，只能从外部再打开。
 *
 * `setIgnoreMouseEvents` 是整窗粒度，没有「只让某块区域穿透」的选项，
 * 所以「只有歌词可交互」只能靠整窗切换来近似。
 */
export function setLyricWindowMouseThrough(enable: boolean): void {
    const w = lyricWindow
    if (!w || w.isDestroyed()) return
    if (enable) w.setIgnoreMouseEvents(true, { forward: true })
    else w.setIgnoreMouseEvents(false)
}

/** 进入歌词窗缩放（渲染端在缩放区按下时开启）。 */
export function startLyricResize(direction: ResizeDirection): void {
    lyricDrag?.startResize(direction)
}

/** 退出歌词窗缩放。 */
export function stopLyricResize(): void {
    lyricDrag?.stopResize()
}

/** 切换歌词窗显隐 */
export function toggleLyricWindow(): void {
    if (isLyricWindowVisible()) closeLyricWindow()
    else openLyricWindow()
}
