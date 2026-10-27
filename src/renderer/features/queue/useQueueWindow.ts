import { useEffect, useState } from 'react'
import { scheduleIdle } from '@renderer/lib/idle'
import {
    centeredWindow,
    coversFocus,
    fitWindow,
    growWindow,
    QUEUE_WINDOW_BATCH,
    QUEUE_WINDOW_INITIAL,
    type QueueWindow,
} from './queueWindow'

/**
 * 队列面板的渐进渲染窗口（时序部分；纯计算在 `queueWindow.ts`）。
 *
 * 终态是全量挂载（与 ListView 的 progressive 一致）：这不是虚拟滚动，
 * 只是把「首次打开一次挂 1000 行」摊成几批小提交。
 *
 * `progressive` 与 `active` 是两件事，别合并：
 *  - `progressive=false`（可拖拽的规模）→ 恒全量，拖拽要求列表完整；
 *  - `progressive=true` 但 `active=false`（面板关着）→ 保持当前窗口、不补齐，
 *    这样面板关着时的切歌成本只有窗口那几十行，而不是全量。
 */

export interface QueueWindowOptions {
    /** 是否启用渐进；false 时恒返回全量（拖拽模式） */
    progressive: boolean
    /** 是否允许在空闲时补齐（面板关着时传 false） */
    active: boolean
    /** 首屏渲染的行数 */
    initial?: number
    /** 空闲时每批补齐的行数 */
    batch?: number
}

/**
 * total  队列长度
 * focus  当前曲下标（-1 = 队列里没有正在播的项）
 */
export function useQueueWindow(
    total: number,
    focus: number,
    {
        progressive,
        active,
        initial = QUEUE_WINDOW_INITIAL,
        batch = QUEUE_WINDOW_BATCH,
    }: QueueWindowOptions,
): QueueWindow {
    const [win, setWin] = useState<QueueWindow>(() => centeredWindow(total, focus, initial))

    // 队列长度 / 当前曲变化时校正窗口。
    // 队列从 0 变长时要立刻给到首屏行数，否则面板会先空一帧、等空闲回调才出行。
    useEffect(() => {
        setWin((w) => {
            const fitted = fitWindow(w, total)
            const floor = Math.min(total, initial)
            if (fitted.count < floor) return centeredWindow(total, focus, floor)
            // 切歌切到窗口外 → 以新位置为中心重建（窗口只会变大，避免看着看着往回缩）
            if (!coversFocus(fitted, focus)) {
                return centeredWindow(total, focus, Math.max(fitted.count, initial))
            }
            return fitted
        })
    }, [total, focus, initial])

    // 空闲时补齐；面板关着（active=false）不排期 —— 看不见的部分不必提交
    useEffect(() => {
        if (!progressive || !active) return
        if (win.count >= total) return
        return scheduleIdle(() => setWin((w) => growWindow(fitWindow(w, total), total, batch)))
    }, [progressive, active, win, total, batch])

    // 关闭渐进（拖拽模式）时恒为全量，与 `useProgressiveCount` 同一口径
    return progressive ? fitWindow(win, total) : { from: 0, count: total }
}
