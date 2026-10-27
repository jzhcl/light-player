/**
 * 系统托盘：图标、tooltip、状态，以及「菜单怎么表现」。
 *
 * - win32 → `trayMenu.ts` 的自绘菜单窗（右键弹窗，状态按 topic 推过去）；
 * - 其他  → Electron 原生 Menu。
 */
import { Tray, Menu, nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'node:path'
import type { AppContext } from './app'
import { requestQuit, showMainWindow } from './app'
import { toggleLyricWindow } from './windows'
import {
    createTrayMenuWindow,
    destroyTrayMenu,
    hideTrayMenu,
    isTrayMenuVisible,
    pushTrayMenuState,
    showTrayMenu,
} from './trayMenu'
import { PATHS } from '@main/constants/paths'
import { TOPIC } from '@shared/topic'
import { publishToTopic } from './ipc/message'

/** 托盘主图标 */
const ICON_RELATIVE_PATH = join('images', 'logo-icon-round.png')

/** 菜单里的播放控制图标目录 */
const MENU_ICON_DIR = join('images', 'tray')

/** Windows 用自绘菜单；其余平台保留原生托盘菜单（Linux 托盘依赖 setContextMenu 才能响应操作） */
const USE_CUSTOM_TRAY_MENU = process.platform === 'win32'

/** 菜单项文案的截断长度：避免菜单宽度随曲名长度抖动。 */
const TITLE_MAX_LEN = 10
const SINGER_MAX_LEN = 3

/**
 * 模块级托盘实例与状态
 */
let tray: Tray | null = null
let state: TrayMenuState = {
    isPlaying: false,
    songTitle: '',
    singer: '',
    isLiked: false,
    playMode: 'loop',
    volume: 0.7,
    lyricVisible: false,
}

/** 菜单图标缓存：只在首次构建时读盘，避免每次更新菜单都重建 */
const iconCache = new Map<string, NativeImage | null>()

/**
 * 按需加载菜单图标（PNG）。文件缺失或加载失败时返回 null，菜单项退化为纯文字。
 */
function loadMenuIcon(name: string): NativeImage | null {
    if (iconCache.has(name)) return iconCache.get(name) ?? null

    const iconPath = join(PATHS.getStatic(), MENU_ICON_DIR, `${name}.png`)
    let icon: NativeImage | null = null
    try {
        const img = nativeImage.createFromPath(iconPath)
        if (img.isEmpty()) {
        } else {
            icon = img.resize({ width: 16, height: 16 })
        }
    } catch (err) {
    }
    iconCache.set(name, icon)
    return icon
}

/** 超长文本截断（尾部加省略号） */
function truncate(text: string, max: number): string {
    if (!text) return ''
    return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 当前曲目显示文案（无曲目时给占位）。 */
function currentSongLabel(): string {
    if (!state.songTitle) return '暂无播放'
    const title = truncate(state.songTitle, TITLE_MAX_LEN)
    const singer = state.singer ? truncate(state.singer, SINGER_MAX_LEN) : ''
    return singer ? `${title} - ${singer}` : title
}

/** 更新 tooltip（不限长，托盘悬停能看全） */
function applyTooltip(): void {
    if (!tray) return
    if (state.songTitle) {
        const suffix = state.singer ? ` - ${state.singer}` : ''
        tray.setToolTip(`${state.songTitle}${suffix}\nLightPlayer`)
    } else {
        tray.setToolTip('LightPlayer')
    }
}

/** 原生菜单 */
function buildMenu(): Menu {
    const playPauseLabel = state.isPlaying ? '暂停' : '播放'
    const playPauseIcon = loadMenuIcon(state.isPlaying ? 'pause' : 'play')

    return Menu.buildFromTemplate([
        { label: currentSongLabel(), enabled: false },
        { type: 'separator' },
        { icon: loadMenuIcon('prev') ?? undefined, label: '上一首', click: () => publishToTopic(TOPIC.MAIN, 'control:previous') },
        { icon: playPauseIcon ?? undefined, label: playPauseLabel, click: () => publishToTopic(TOPIC.MAIN, 'control:playPause')},
        { icon: loadMenuIcon('next') ?? undefined, label: '下一首', click: () => publishToTopic(TOPIC.MAIN, 'control:next')},
        { type: 'separator' },
        {
            label: state.lyricVisible ? '关闭桌面歌词' : '打开桌面歌词',
            click: () => toggleLyricWindow(),
        },
        { type: 'separator' },
        { label: '显示主窗口', click: () => showMainWindow(ctxRef!) },
        { label: '退出', click: () => requestQuit(ctxRef!) },
    ])
}

/** 主窗引用：创建托盘时注入一次，供菜单回调使用。 */
let ctxRef: AppContext | null = null

/**
 * 从主进程收到的开关状态刷新托盘。
 * 由 `windows.ts` 经回调触发，渲染端不参与上报。
 */
export function syncLyricVisible(visible: boolean): void {
    updateTrayState({ lyricVisible: visible })
}

/**
 * 切换主窗显隐
 */
function toggleMainWindow(): void {
    const win = ctxRef?.mainWindow
    if (!win || win.isDestroyed()) return
    if (win.isVisible() && !win.isMinimized()) {
        win.hide()
    } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
    }
}

/** 自绘菜单的状态快照（渲染端挂载时主动拉取） */
export function getTrayMenuState(): TrayMenuState {
    return state
}

/** 创建托盘 */
export function createTray(ctx: AppContext): Tray | null {
    ctxRef = ctx
    const iconPath = join(PATHS.getStatic(), ICON_RELATIVE_PATH)

    let instance: Tray
    try {
        const icon = nativeImage.createFromPath(iconPath)
        if (icon.isEmpty()) {
            return null
        }
        // 托盘图标按 16px 缩放，避免高分辨率 PNG 在小尺寸托盘中被裁切
        instance = new Tray(icon.resize({ width: 16, height: 16 }))
    } catch (err) {
        return null
    }

    tray = instance
    applyTooltip()

    if (USE_CUSTOM_TRAY_MENU) {
        // 先把页面在后台加载完
        createTrayMenuWindow()
        instance.on('right-click', () => {
            if (!tray) return
            pushTrayMenuState(state)
            showTrayMenu(tray.getBounds())
        })
        instance.on('click', () => {
            // 菜单打开时左键点托盘只负责关菜单
            if (isTrayMenuVisible()) {
                hideTrayMenu()
                return
            }
            toggleMainWindow()
        })
    } else {
        instance.setContextMenu(buildMenu())
        instance.on('click', () => toggleMainWindow())
    }

    return tray
}

/**
 * 更新托盘状态并立即反映到菜单与 tooltip。
 * 渲染端经 `tray:updateState` 上报；只传变化的字段即可。
 */
export function updateTrayState(patch: Partial<TrayMenuState>): void {
    const prev = state
    const next = { ...state, ...patch }
    // 幂等短路：内容没变就不推送
    if (
        next.isPlaying === prev.isPlaying &&
        next.songTitle === prev.songTitle &&
        next.singer === prev.singer &&
        next.isLiked === prev.isLiked &&
        next.playMode === prev.playMode &&
        next.volume === prev.volume &&
        next.lyricVisible === prev.lyricVisible
    ) {
        return
    }
    state = next

    if (prev.songTitle !== next.songTitle || prev.singer !== next.singer) {
        applyTooltip()
    }

    if (USE_CUSTOM_TRAY_MENU) {
        pushTrayMenuState(state)
        return
    }

    if (!tray) return
    // 原生菜单只关心这几项；音量等高频变化不重建
    if (
        prev.isPlaying !== next.isPlaying ||
        prev.songTitle !== next.songTitle ||
        prev.singer !== next.singer ||
        prev.lyricVisible !== next.lyricVisible
    ) {
        tray.setContextMenu(buildMenu())
    }
}

/** 销毁托盘并重置状态。 */
export function destroyTray(): void {
    destroyTrayMenu()
    tray?.destroy()
    tray = null
    ctxRef = null
    state = {
        isPlaying: false,
        songTitle: '',
        singer: '',
        isLiked: false,
        playMode: 'loop',
        volume: 0.7,
        lyricVisible: false,
    }
}
