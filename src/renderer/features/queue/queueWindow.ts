/**
 * 队列面板渐进窗口的纯计算。时序部分在 `useQueueWindow.ts`。
 *
 * 与 `useProgressiveCount` 的区别在起点：那个是前缀式（渲染前 N 行），而队列面板打开时
 * 要「滚到当前曲」—— 当前曲可能在队列第 800 行，只渲染前缀的话那一行根本不存在，
 * 自动定位会直接失效。所以这里的初始窗口以当前曲为中心，之后向两侧补齐。
 */

export interface QueueWindow {
    /** 起始下标（含） */
    from: number
    /** 渲染行数 */
    count: number
}

/** 首屏渲染的行数 */
export const QUEUE_WINDOW_INITIAL = 60
/** 空闲时每批补齐的行数 */
export const QUEUE_WINDOW_BATCH = 60
/** 当前曲放在窗口偏上（约 40%）：下方留更多行，用户更常往下看 */
const FOCUS_LEAD_RATIO = 0.4

/** 以 focus 为中心开一个 size 行的窗口（focus < 0 时从头开始） */
export function centeredWindow(total: number, focus: number, size: number): QueueWindow {
    const count = Math.max(0, Math.min(total, size))
    if (count === 0) return { from: 0, count: 0 }
    if (focus < 0) return { from: 0, count }
    const lead = Math.floor(count * FOCUS_LEAD_RATIO)
    return { from: Math.max(0, Math.min(total - count, focus - lead)), count }
}

/** 收进 `[0, total]` 范围。不需要改时返回同一引用 */
export function fitWindow(w: QueueWindow, total: number): QueueWindow {
    const count = Math.max(0, Math.min(w.count, total))
    const from = Math.max(0, Math.min(w.from, total - count))
    return from === w.from && count === w.count ? w : { from, count }
}

/** 向两侧各扩一半；一侧到边界就把余量让给另一侧 */
export function growWindow(w: QueueWindow, total: number, batch: number): QueueWindow {
    const room = total - w.count
    if (room <= 0) return w
    const step = Math.min(batch, room)
    const back = w.from
    const front = total - (w.from + w.count)
    const wantBack = Math.min(back, Math.floor(step / 2))
    const wantFront = Math.min(front, step - wantBack)
    // 后面不够时，剩下的额度补到前面
    const addBack = wantBack + Math.min(back - wantBack, step - wantBack - wantFront)
    const addFront = wantFront
    if (addBack === 0 && addFront === 0) return w
    return { from: w.from - addBack, count: w.count + addBack + addFront }
}

/** 窗口是否覆盖某个下标（focus < 0 视为不需要覆盖） */
export function coversFocus(w: QueueWindow, focus: number): boolean {
    return focus < 0 || (focus >= w.from && focus < w.from + w.count)
}
