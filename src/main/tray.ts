/**
 * 系统托盘：图标、tooltip、菜单栏歌词，以及「菜单怎么表现」。
 *
 * - win32 → `trayMenu.ts` 的自绘菜单窗（右键弹窗，状态按 topic 推过去）；
 * - 其他  → Electron 原生 Menu（macOS 用原生菜单是平台惯例，能沾到系统高亮、
 *           键盘导航与 VoiceOver）。
 *
 * macOS 额外承担一件事：把当前歌词画成位图贴进菜单栏（`tray.setImage`）。
 */
import { Tray, Menu, nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { Buffer } from 'node:buffer'
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

/** 菜单里的播放控制图标目录 */
const MENU_ICON_DIR = join('images', 'tray')

/** 托盘图标 */
const ICON_RELATIVE_PATH = join(MENU_ICON_DIR, 'logo.png')

/** 托盘图标逻辑尺寸：Windows 托盘 16px；macOS 菜单栏 20pt */
const TRAY_ICON_SIZE = process.platform === 'darwin' ? 20 : 16

/** Windows 用自绘菜单；其余平台保留原生托盘菜单（Linux 托盘依赖 setContextMenu 才能响应操作） */
const USE_CUSTOM_TRAY_MENU = process.platform === 'win32'

/** 菜单项文案的截断长度：避免菜单宽度随曲名长度抖动。 */
const TITLE_MAX_LEN = 10
const SINGER_MAX_LEN = 3

/**
 * 菜单栏歌词走位图（`tray.setImage`），不走 `setTitle`。
 *
 * 位图尺寸约定：宽高都按 2x 出图（Retina），交给 `nativeImage` 的
 * `scaleFactor: 2` 收回到逻辑尺寸，菜单栏才会按 pt 排版而不是按像素。
 */

/** 位图的 Retina 倍率：与渲染端出图时一致 */
const BAR_IMAGE_SCALE = 2

/**
 * 模块级托盘实例与状态
 *
 * macOS 用两个托盘项：
 * - `iconTray` 只放图标，位置永远不动；
 * - `textTray` 是一个 1×1 透明图标 + 标题，用来承载歌词。
 *
 * 状态栏项是从右往左排的，后建的插在更左边 —— 所以 textTray 落在 iconTray 左侧。
 * 歌词变长时只有 textTray 的左边缘向外扩，图标一动不动。
 */
let iconTray: Tray | null = null
let textTray: Tray | null = null

/** 1×1 全透明 PNG：给纯文字托盘项一个合法的图像占位 */
const BLANK_ICON_PNG =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const INITIAL_STATE: TrayMenuState = {
    isPlaying: false,
    songTitle: '',
    singer: '',
    isLiked: false,
    playMode: 'loop',
    volume: 0.7,
    lyricVisible: false,
}
let state: TrayMenuState = { ...INITIAL_STATE }

/** 上一次贴进菜单栏的图片数据，用于跳过重复解码 + setImage */
let lastLyricImage = ''

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
    if (!iconTray) return
    if (state.songTitle) {
        const suffix = state.singer ? ` - ${state.singer}` : ''
        iconTray.setToolTip(`${state.songTitle}${suffix}\nLightPlayer`)
    } else {
        iconTray.setToolTip('LightPlayer')
    }
}

/** 空白占位图：托盘项必须有图，清空歌词时用它把宽度收回最小 */
function blankImage(): NativeImage {
    return nativeImage.createFromBuffer(Buffer.from(BLANK_ICON_PNG, 'base64'))
}

/**
 * 确保歌词项存在。
 *
 * Electron 的 `Tray` 没有 `setVisible`，「不显示」只能销毁 —— 所以关掉歌词时
 * 这一项是真的从菜单栏拿掉了，而不是留一个空占位。后建的项落在更左边，
 * 重建后仍然待在托盘图标左侧。
 */
function ensureTextTray(): Tray | null {
    if (process.platform !== 'darwin') return null
    if (textTray && !textTray.isDestroyed()) return textTray

    try {
        textTray = new Tray(blankImage())
    } catch (err) {
        textTray = null
    }
    return textTray
}

/** 把歌词项从菜单栏摘掉 */
function dropTextTray(): void {
    if (!textTray) return
    if (!textTray.isDestroyed()) textTray.destroy()
    textTray = null
}

/**
 * 把渲染端画好的菜单栏位图贴上去。
 *
 * 渲染端负责「画什么」：取哪句歌词、裁到哪个像素、深浅色用哪种前景色。
 * 主进程只做解码 + 贴图，不参与排版。
 *
 * `null` = 关掉 / 没有内容：直接把这一项从菜单栏摘掉，只留托盘图标。
 * 这一项在首次挂图时才创建，所以「设置里关着」时菜单栏从头到尾都不会多出东西。
 */
export function setTrayLyricImage(dataUrl: string | null): void {
    if (process.platform !== 'darwin') return

    const next = dataUrl ?? ''
    if (next === lastLyricImage) return
    lastLyricImage = next

    if (!next) {
        dropTextTray()
        return
    }

    const comma = next.indexOf(',')
    const base64 = comma >= 0 ? next.slice(comma + 1) : next
    const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'), {
        scaleFactor: BAR_IMAGE_SCALE,
    })
    if (image.isEmpty()) return

    const tray = ensureTextTray()
    if (!tray) return
    tray.setImage(image)
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

/**
 * 构建托盘图标。
 *
 * 源图比托盘槽位大得多，`resize()` 出来的位图 scaleFactor 恒为 1，
 * 在 HiDPI 屏上会被系统再放大一次从而发虚 —— 所以显式给 1x / 2x 两档表示。
 */
function createTrayIcon(): NativeImage {
    const source = nativeImage.createFromPath(join(PATHS.getStatic(), ICON_RELATIVE_PATH))
    if (source.isEmpty()) return source

    const icon = nativeImage.createEmpty()
    for (const scaleFactor of [1, 2]) {
        const size = TRAY_ICON_SIZE * scaleFactor
        icon.addRepresentation({
            scaleFactor,
            buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
        })
    }
    return icon
}

/** 创建托盘 */
export function createTray(ctx: AppContext): Tray | null {
    ctxRef = ctx

    let instance: Tray
    try {
        const icon = createTrayIcon()
        if (icon.isEmpty()) {
            return null
        }
        instance = new Tray(icon)
    } catch (err) {
        return null
    }

    iconTray = instance
    applyTooltip()

    if (USE_CUSTOM_TRAY_MENU) {
        // 先把页面在后台加载完
        createTrayMenuWindow()

        const openMenu = (): void => {
            // 面板开着时再点托盘 = 收起。blur 已把它藏起来了，靠 trayMenu 内部的时间戳
            // 短路掉这次「重新打开」，否则表现为「怎么点都关不掉」。
            if (isTrayMenuVisible()) {
                hideTrayMenu()
                return
            }
            pushTrayMenuState(state)
            // 定位一律以图标项为准：文字项宽度固定，但拿它算仍不如图标稳
            if (iconTray && !iconTray.isDestroyed()) showTrayMenu(iconTray.getBounds())
            else if (!instance.isDestroyed()) showTrayMenu(instance.getBounds())
        }

        instance.on('right-click', openMenu)
        instance.on('click', () => {
            if (isTrayMenuVisible()) {
                hideTrayMenu()
                return
            }
            toggleMainWindow()
        })
    } else {
        // macOS / Linux：系统原生菜单。
        //
        // macOS 上设了 context menu 之后，左键点击由系统直接转给菜单，
        // `click` 事件不会再触发（平台限制），所以这里只在 Linux 上挂主窗开关。
        instance.setContextMenu(buildMenu())
        if (process.platform === 'linux') {
            instance.on('click', () => toggleMainWindow())
        }
    }

    return iconTray
}

/** 面板/原生菜单关心的字段是否变化（不含歌词） */
function panelStateChanged(prev: TrayMenuState, next: TrayMenuState): boolean {
    return (
        prev.isPlaying !== next.isPlaying ||
        prev.songTitle !== next.songTitle ||
        prev.singer !== next.singer ||
        prev.isLiked !== next.isLiked ||
        prev.playMode !== next.playMode ||
        prev.volume !== next.volume ||
        prev.lyricVisible !== next.lyricVisible
    )
}

/**
 * 更新托盘状态并立即反映到 tooltip / 面板。
 * 渲染端经 `tray:updateState` 上报；只传变化的字段即可。
 * 菜单栏歌词不走这条通道，走 `setTrayLyricImage` 的位图。
 */
export function updateTrayState(patch: Partial<TrayMenuState>): void {
    const prev = state
    const next = { ...state, ...patch }

    const metaChanged = next.songTitle !== prev.songTitle || next.singer !== prev.singer

    // 幂等短路：整包没变就不做任何事
    if (!metaChanged && !panelStateChanged(prev, next)) return

    state = next

    if (metaChanged) applyTooltip()

    // 只有歌名/歌手变了：tooltip 已经更新完，面板与原生菜单都不用动
    if (!panelStateChanged(prev, next)) return

    if (USE_CUSTOM_TRAY_MENU) {
        pushTrayMenuState(state)
        return
    }

    if (!iconTray) return
    // 原生菜单只关心这几项；音量等高频变化不重建
    if (
        prev.isPlaying !== next.isPlaying ||
        prev.songTitle !== next.songTitle ||
        prev.singer !== next.singer ||
        prev.lyricVisible !== next.lyricVisible
    ) {
        iconTray.setContextMenu(buildMenu())
    }
}

/** 销毁托盘并重置状态。 */
export function destroyTray(): void {
    destroyTrayMenu()
    dropTextTray()
    iconTray?.destroy()
    iconTray = null
    ctxRef = null
    state = { ...INITIAL_STATE }
    lastLyricImage = ''
}
