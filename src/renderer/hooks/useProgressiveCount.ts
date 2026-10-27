import { useEffect, useState } from 'react'
import { scheduleIdle } from '@renderer/lib/idle'

/**
 * 渐进渲染：一次只渲染前 `count` 行，其余在浏览器空闲时按批追加。
 *
 * 解决的问题：上千行的歌单页一次性挂载会卡住主线程（一次长任务）；
 * 切成每批 60 行的小提交后，首屏立刻可见，后续批次穿插在空闲时间里，用户无感。
 */
export interface ProgressiveOptions {
    /** 首屏同步渲染的行数，默认 60 */
    initial?: number
    /** 空闲时每批追加的行数，默认 60 */
    batch?: number
}

const DEFAULT_INITIAL = 60
const DEFAULT_BATCH = 60

/**
 * total   总行数
 * enabled 关闭时恒等于 total（不做任何切片）
 * @returns 本次应渲染的行数（前缀长度，永不超过 total）
 */
export function useProgressiveCount(
    total: number,
    enabled: boolean,
    { initial = DEFAULT_INITIAL, batch = DEFAULT_BATCH }: ProgressiveOptions = {},
): number {
    const [count, setCount] = useState(() => (enabled ? Math.min(initial, total) : total))

    // count 每次推进都会触发下一轮调度，直到追平 total。
    // 每批一次独立提交。
    useEffect(() => {
        if (!enabled || count >= total) return
        return scheduleIdle(() => setCount((c) => Math.min(total, c + batch)))
    }, [enabled, count, total, batch])

    // min 兼顾两种情形：尚未渲染完（count < total）、数据变少（count > total）
    return enabled ? Math.min(count, total) : total
}
