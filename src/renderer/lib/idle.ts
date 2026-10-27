/**
 * 空闲调度：优先 requestIdleCallback（Chromium / Electron 原生支持），退化到 setTimeout。
 *
 * @returns 取消函数（在下一次调度发生前调用可撤销）
 */
export function scheduleIdle(task: () => void): () => void {
    if (typeof requestIdleCallback === 'function') {
        // timeout 兜底：即便浏览器一直不空闲，也会在 100ms 内强制执行，避免饿死
        const id = requestIdleCallback(() => task(), { timeout: 100 })
        return () => cancelIdleCallback(id)
    }
    const id = setTimeout(task, 16)
    return () => clearTimeout(id)
}

/**
 * 循环空闲调度：反复排下一批，直到 `task` 返回 `false`（自述「已收工」）或调用方取消。
 *
 * @param task 一批工作。返回 `true` 表示还有下一批（继续排程），`false` 表示已全部完成
 * @returns 取消函数：在任何时刻调用都能停下循环（含已排程但未执行的那一批）
 */
export function scheduleIdleLoop(task: () => boolean): () => void {
    let cancelled = false
    let cancelCurrent: (() => void) | null = null

    const step = () => {
        if (cancelled) return
        if (!task()) {
            cancelCurrent = null
            return
        }
        cancelCurrent = scheduleIdle(step)
    }

    cancelCurrent = scheduleIdle(step)

    return () => {
        cancelled = true
        cancelCurrent?.()
        cancelCurrent = null
    }
}
