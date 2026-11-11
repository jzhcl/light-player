import { screen, type BrowserWindow } from 'electron'

/** 客户区鼠标移动 */
const WM_MOUSEMOVE = 0x0200
/** 客户区按下左键 */
const WM_LBUTTONDOWN = 0x0201
/** 客户区松开左键 */
const WM_LBUTTONUP = 0x0202
/** wParam 低位里「左键按下」的位标志 */
const MK_LBUTTON = 0x0001

/** 最小尺寸，与 BrowserWindow 的 minWidth/minHeight 对齐 */
const MIN_WIDTH = 200
const MIN_HEIGHT = 100

/**
 * macOS 拖拽/缩放的光标轮询间隔。
 *
 * macOS 没有 Windows 那套窗口消息可挂，只能自己采样光标位置；16ms ≈ 一帧，
 * 跟手程度与 win32 那条路径相当。
 */
const POLL_INTERVAL_MS = 16

/**
 * 单次拖拽/缩放的硬上限。
 *
 * 渲染端漏发 stop（指针在窗口外松手、穿透切换把 pointerup 吃掉）时，
 * 轮询停不下来就会让窗口一路跟着光标跑 —— 到点强制收摊。
 */
const SESSION_MAX_MS = 15_000

/** 八个缩放方向 */
export type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface DragController {
    /**
     * 开关拖拽。关掉后按住左键不再移动窗口
     */
    setEnabled(enabled: boolean): void
    /** 进入缩放模式：下一次按住拖动改的是窗口边缘，不再是整体位置。 */
    startResize(direction: ResizeDirection): void
    /** 退出缩放模式（松手 / 渲染端取消）。 */
    stopResize(): void
    /**
     * 开始整窗拖拽。macOS 由渲染端在按下左键时通知（见 renderer-lyric/useMove）；
     * win32 的拖拽由窗口消息自己驱动，这里是 no-op。
     */
    startMove(): void
    /** 结束整窗拖拽。同上。 */
    stopMove(): void
}

/** 起手基准：按下那一刻的鼠标屏幕坐标、窗口位置，以及窗口尺寸。 */
interface MoveOrigin {
    screenX: number
    screenY: number
    winX: number
    winY: number
    width: number
    height: number
}

/**
 * 让窗口「任意位置都能拖」，并支持从窗口内部触发的缩放。
 *
 * - win32：hook 窗口消息，左键按着时的 `WM_MOUSEMOVE` 就是驱动器；
 * - macOS：没有等价的消息钩子，改由渲染端通知按下/松手（`startMove` / `stopMove`），
 *   主进程按帧轮询光标位置来驱动。
 *
 * 都用屏幕坐标，不用客户区坐标 —— 窗口在我们脚下移动，客户区坐标会把
 * 「窗口自己的位移」算进鼠标位移里，拖动速度只剩一半。
 */
export function makeWindowFullyDraggable(win: BrowserWindow): DragController {
    let enabled = true

    /** 当前交互：空闲 / 拖位置 / 缩尺寸 */
    let mode: 'idle' | 'drag' | 'resize' = 'idle'

    let origin: MoveOrigin | null = null

    /** 缩放的起手基准：方向 + 按下那一刻的鼠标屏幕坐标与窗口矩形 */
    let resizeBase: {
        dir: ResizeDirection
        screenX: number
        screenY: number
        bounds: Electron.Rectangle
    } | null = null

    /** 待落地的位置与尺寸。一轮事件循环里可能收到好几个采样，只应用最后一个。 */
    let pending: { x: number; y: number; width: number; height: number } | null = null
    let flushScheduled = false

    /** 把排队的位移落到窗口上 —— 跑在事件回调之外，安全。 */
    const flush = (): void => {
        flushScheduled = false
        const p = pending
        pending = null
        if (p && !win.isDestroyed()) win.setBounds(p)
    }

    /** 与当前矩形一致就不打扰系统；有变化才合并到最后落地一次 */
    const schedule = (next: { x: number; y: number; width: number; height: number }): void => {
        const b = win.getBounds()
        if (next.x === b.x && next.y === b.y && next.width === b.width && next.height === b.height) return
        pending = next
        if (!flushScheduled) {
            flushScheduled = true
            setImmediate(flush)
        }
    }

    /** 记一次起手基准：按下那一刻的鼠标屏幕坐标 + 窗口矩形 */
    const recordOrigin = (cursor: Electron.Point): void => {
        const b = win.getBounds()
        origin = {
            screenX: cursor.x,
            screenY: cursor.y,
            winX: b.x,
            winY: b.y,
            width: b.width,
            height: b.height,
        }
    }

    /** 拖位置。首次采样没有基准就先补一个（按下时的基准丢了也能接上）。 */
    const moveTo = (cursor: Electron.Point): void => {
        if (!enabled) {
            origin = null
            return
        }
        if (!origin) {
            recordOrigin(cursor)
            return
        }

        // 必须用 setBounds 并把起手时记下的尺寸一起传回去，不能用 setPosition。
        // setPosition 内部是「取当前尺寸，再连同新坐标设回去」，而 Electron 记录的尺寸与
        // Windows 实际窗口矩形之间恒定差着一点，于是每调一次就被放大一次。
        schedule({
            x: origin.winX + (cursor.x - origin.screenX),
            y: origin.winY + (cursor.y - origin.screenY),
            width: origin.width,
            height: origin.height,
        })
    }

    /** 缩尺寸 */
    const resizeTo = (cursor: Electron.Point): void => {
        const base = resizeBase
        if (!base) return
        const b = base.bounds
        const d = base.dir
        let dx = cursor.x - base.screenX
        let dy = cursor.y - base.screenY

        // 先钳制增量再算矩形，否则缩到最小之后往回拖会「粘」在原地
        if (d.includes('w') && b.width - dx < MIN_WIDTH) dx = b.width - MIN_WIDTH
        if (d.includes('e') && b.width + dx < MIN_WIDTH) dx = MIN_WIDTH - b.width
        if (d.includes('n') && b.height - dy < MIN_HEIGHT) dy = b.height - MIN_HEIGHT
        if (d.includes('s') && b.height + dy < MIN_HEIGHT) dy = MIN_HEIGHT - b.height

        schedule({
            x: d.includes('w') ? b.x + dx : b.x,
            y: d.includes('n') ? b.y + dy : b.y,
            width: d.includes('w') ? b.width - dx : d.includes('e') ? b.width + dx : b.width,
            height: d.includes('n') ? b.height - dy : d.includes('s') ? b.height + dy : b.height,
        })
    }

    /** 采样一次光标，按当前模式落到窗口上 */
    const track = (cursor: Electron.Point): void => {
        if (mode === 'resize') resizeTo(cursor)
        else if (mode === 'drag') moveTo(cursor)
    }

    /** 进入缩放模式：方向 + 起手基准。两平台共用 */
    const beginResize = (direction: ResizeDirection): void => {
        if (win.isDestroyed()) return
        const b = win.getBounds()
        const c = screen.getCursorScreenPoint()
        resizeBase = { dir: direction, screenX: c.x, screenY: c.y, bounds: b }
        mode = 'resize'
        // 缩放期间不该再走拖位置那条路
        origin = null
    }

    // ============================================================
    // win32：挂窗口消息
    // ============================================================

    if (process.platform === 'win32') {
        // 每次按下都重算基准：万一上一次的 WM_LBUTTONUP 没送到（在窗口外松手又没拿到
        // 鼠标捕获），残留的 origin 会让下一次拖动的第一帧按一整段旧位移跳过去。
        // 在 DOWN 里就摆好基准还有个好处：按下后的第一次移动即生效，不用先吃掉一帧。
        win.hookWindowMessage(WM_LBUTTONDOWN, () => {
            // 缩放开始于同一次按下，别把拖位置的基准插进来
            if (mode === 'resize') return
            if (!enabled || win.isDestroyed()) {
                origin = null
                return
            }
            // win32 没有 macOS 那种「渲染端通知起止」，按下就是这一轮拖拽的起点 ——
            // mode 不置成 drag 的话 track() 不会走 moveTo
            mode = 'drag'
            recordOrigin(screen.getCursorScreenPoint())
        })

        win.hookWindowMessage(WM_LBUTTONUP, () => {
            origin = null
            resizeBase = null
            mode = 'idle'
        })

        win.hookWindowMessage(WM_MOUSEMOVE, (wParam: Buffer) => {
            if (win.isDestroyed()) return

            // wParam 低位是此刻按下的键，没按左键就只是普通移动
            if (!(wParam.readInt16LE(0) & MK_LBUTTON)) {
                origin = null
                return
            }

            // 兜底：透明无边框窗上实测收不到 WM_LBUTTONDOWN，
            // 只靠按下那一刻置 mode 会整条链路失效。左键按着还在移动，就是拖拽进行中。
            if (mode === 'idle') mode = 'drag'

            track(screen.getCursorScreenPoint())
        })

        return {
            setEnabled(next: boolean) {
                enabled = next
                // 关闭时把基准丢掉：下次按下重新起算，避免拿一段陈旧位移接着算
                if (!next) origin = null
            },
            startResize: beginResize,
            stopResize() {
                resizeBase = null
                mode = 'idle'
            },
            // win32 的按下/松手来自窗口消息，渲染端那两个信号没有落点
            startMove() {},
            stopMove() {},
        }
    }

    // ============================================================
    // macOS：渲染端驱动 + 光标轮询
    // ============================================================

    if (process.platform === 'darwin') {
        let timer: ReturnType<typeof setInterval> | null = null
        let sessionStart = 0

        const stopSession = (): void => {
            if (timer) clearInterval(timer)
            timer = null
            mode = 'idle'
            origin = null
            resizeBase = null
        }

        /** 起轮询。已在轮询中就不重开（拖拽中途转缩放会接着用同一个循环） */
        const startSession = (): void => {
            if (timer || win.isDestroyed()) return
            sessionStart = Date.now()
            timer = setInterval(() => {
                if (win.isDestroyed() || Date.now() - sessionStart > SESSION_MAX_MS) {
                    stopSession()
                    return
                }
                track(screen.getCursorScreenPoint())
            }, POLL_INTERVAL_MS)
        }

        return {
            setEnabled(next: boolean) {
                enabled = next
                // 关掉拖拽时把正在跑的一轮也停掉：锁定 / 指针落到工具栏时不该还在跟手
                if (!next) {
                    origin = null
                    stopSession()
                }
            },
            startMove() {
                if (!enabled || mode === 'resize' || win.isDestroyed()) return
                mode = 'drag'
                recordOrigin(screen.getCursorScreenPoint())
                startSession()
            },
            stopMove() {
                if (mode === 'drag') stopSession()
            },
            startResize(direction) {
                beginResize(direction)
                // win32 靠 WM_MOUSEMOVE 驱动，macOS 得自己起轮询
                startSession()
            },
            stopResize() {
                if (mode === 'resize') stopSession()
            },
        }
    }

    // ============================================================
    // 其它平台：窗口系统不提供拖拽/缩放能力
    // ============================================================

    return {
        setEnabled() {},
        startResize() {},
        stopResize() {},
        startMove() {},
        stopMove() {},
    }
}
