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
}

/**
 * 让窗口「任意位置都能拖」，并支持从窗口内部触发的缩放。
 *
 * 原理：hook WM_MOUSEMOVE，左键按着时按「鼠标的屏幕位移」平移窗口。
 * 不干预命中测试，页面元素照常收自己该收的事件。缩放同理，只是算的是矩形增量。
 *
 */
export function makeWindowFullyDraggable(win: BrowserWindow): DragController {
    let enabled = true

    /** 当前交互：空闲 / 拖位置 / 缩尺寸 */
    let mode: 'idle' | 'drag' | 'resize' = 'idle'

    /**
     * 起手基准：按下那一刻的鼠标屏幕坐标、窗口位置，以及窗口尺寸。null = 当前没在拖。
     */
    let origin: {
        screenX: number
        screenY: number
        winX: number
        winY: number
        width: number
        height: number
    } | null = null

    /** 缩放的起手基准：方向 + 按下那一刻的鼠标屏幕坐标与窗口矩形 */
    let resizeBase: {
        dir: ResizeDirection
        screenX: number
        screenY: number
        bounds: Electron.Rectangle
    } | null = null

    /** 待落地的位置与尺寸。一轮事件循环里可能收到好几个 WM_MOUSEMOVE，只应用最后一个。 */
    let pending: { x: number; y: number; width: number; height: number } | null = null
    let flushScheduled = false

    if (process.platform !== 'win32') {
        return { setEnabled() {}, startResize() {}, stopResize() {} }
    }

    /** 把排队的位移落到窗口上 —— 跑在 WndProc 之外，安全。 */
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
        const b = win.getBounds()
        const c = screen.getCursorScreenPoint()
        origin = {
            screenX: c.x,
            screenY: c.y,
            winX: b.x,
            winY: b.y,
            width: b.width,
            height: b.height,
        }
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

        // 这里必须用屏幕坐标，不能用消息 lParam 里的客户区坐标。
        // 客户区坐标 = 屏幕坐标 − 窗口位置，而窗口正在我们脚下移动：拿它当位移基准的话，
        // 窗口每跟手一像素，「鼠标位移」就被自己的移动抵消掉一像素 —— 设鼠标走了 d、窗口
        // 已走了 e，则递推 e' = d − e，解出来窗口只以大约一半的速度前进，
        // 拖起来就是一路被鼠标甩在后面。
        const cursor = screen.getCursorScreenPoint()

        // ---- 缩放 ----
        if (mode === 'resize') {
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
            return
        }

        // ---- 拖位置 ----
        if (!enabled) {
            origin = null
            return
        }

        if (!origin) {
            // 基准只在起手那一刻取一次
            const b = win.getBounds()
            origin = {
                screenX: cursor.x,
                screenY: cursor.y,
                winX: b.x,
                winY: b.y,
                width: b.width,
                height: b.height,
            }
            return
        }

        const x = origin.winX + (cursor.x - origin.screenX)
        const y = origin.winY + (cursor.y - origin.screenY)

        // 必须用 setBounds 并把起手时记下的尺寸一起传回去，不能用 setPosition。
        // setPosition 内部是「取当前尺寸，再连同新坐标设回去」，而 Electron 记录的尺寸与
        // Windows 实际窗口矩形之间恒定差着一点，于是每调一次就被放大一次。
        schedule({ x, y, width: origin.width, height: origin.height })
    })

    return {
        setEnabled(next: boolean) {
            enabled = next
            // 关闭时把基准丢掉：下次按下重新起算，避免拿一段陈旧位移接着算
            if (!next) origin = null
        },
        startResize(direction: ResizeDirection) {
            if (win.isDestroyed()) return
            const b = win.getBounds()
            const c = screen.getCursorScreenPoint()
            resizeBase = { dir: direction, screenX: c.x, screenY: c.y, bounds: b }
            mode = 'resize'
            // 缩放期间不该再走拖位置那条路
            origin = null
        },
        stopResize() {
            resizeBase = null
            mode = 'idle'
        },
    }
}
