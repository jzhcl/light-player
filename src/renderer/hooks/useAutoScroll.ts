import { useCallback, useEffect, useRef, type RefObject } from 'react'

// 拖拽时的平滑自动滚动引擎（rAF 连续插值，非逐帧固定步长）。
// 只要在移动时把指针 clientY 喂给 update()，引擎就按离容器上下边缘的距离线性加速滚动

export interface UseAutoScrollOptions<T extends HTMLElement = HTMLElement> {
    /** 需要被自动滚动的容器 ref */
    scrollRef: RefObject<T | null>
    /** 距上/下边缘多少 px 内开始滚动，默认 48 */
    edge?: number
    /** 紧贴边缘时的最大速度 px/s，默认 700 */
    maxSpeed?: number
    /** 速度趋近目标的缓入系数，越大起滚越利落、越小越柔，默认 14 */
    ramp?: number
}

export interface AutoScrollController {
    /** 拖拽开始：打开闸门并重置速度/累加器（避免上次残留）。不主动起滚，等首次 update。 */
    start: () => void
    /** 拖拽结束/取消：关闭闸门、停止 rAF、清理状态。 */
    stop: () => void
    /** 每次拖拽指针移动时喂入指针 Y 坐标；据此计算目标速度并维持 rAF 循环。 */
    update: (clientY: number) => void
}

export function useAutoScroll<T extends HTMLElement = HTMLElement>({
    scrollRef,
    edge = 48,
    maxSpeed = 700,
    ramp = 14,
}: UseAutoScrollOptions<T>): AutoScrollController {
    const vel = useRef(0) // 当前实际速度 px/s，逐帧缓入到 targetVel
    const targetVel = useRef(0) // 由指针位置算得的目标速度
    const acc = useRef(0) // 亚像素累加器：低速时攒小数滚动，避免整像素跳动
    const raf = useRef<number | null>(null)
    const lastTs = useRef(0)
    const active = useRef(false) // 拖拽进行中闸门，stop 即关

    const stop = useCallback(() => {
        active.current = false
        vel.current = 0
        targetVel.current = 0
        acc.current = 0
        if (raf.current != null) {
            cancelAnimationFrame(raf.current)
            raf.current = null
        }
    }, [])

    const tick = useCallback(
        (now: number) => {
            const el = scrollRef.current
            // 闸门：拖拽已结束则立即停止，避免松手后循环继续滚动
            if (!active.current || !el) {
                stop()
                return
            }
            // dt 钳制：标签页切回等导致 rAF 暂停后，避免一次性巨步跳动
            const dt = Math.min(0.05, (now - lastTs.current) / 1000)
            lastTs.current = now
            // 速度逐帧缓入到目标：消除突然起滚 / 速度突变的顿挫
            vel.current += (targetVel.current - vel.current) * Math.min(1, dt * ramp)
            const v = vel.current
            // 目标为 0 且已缓入到近乎停止 → 结束循环（避免空转）
            if (Math.abs(v) < 1 && targetVel.current === 0) {
                stop()
                return
            }
            // 亚像素累加：低速时每帧不足 1px 的小数滚动攒起来，够 1px 才落，
            // 避免整像素取整造成的 0/1 不规则跳动（小幅拖拽时最明显）。
            const desired = v * dt + acc.current
            const before = el.scrollTop
            el.scrollTop += desired
            const applied = el.scrollTop - before
            // 被边界夹取（applied 仍为 0）时丢弃累加，防止松夹后突然补跳
            acc.current = applied === 0 && desired !== 0 ? 0 : desired - applied
            raf.current = requestAnimationFrame(tick)
        },
        [scrollRef, ramp, stop],
    )

    const startLoop = useCallback(() => {
        if (raf.current == null) {
            lastTs.current = performance.now()
            raf.current = requestAnimationFrame(tick)
        }
    }, [tick])

    // 由指针 Y 计算目标速度：靠近上/下边缘按距离线性加速到 ±maxSpeed，否则 0
    const update = useCallback(
        (clientY: number) => {
            const el = scrollRef.current
            if (!el) {
                targetVel.current = 0
                return
            }
            const rect = el.getBoundingClientRect()
            if (clientY < rect.top + edge) {
                const dist = Math.max(0, rect.top + edge - clientY)
                targetVel.current = -Math.min(1, dist / edge) * maxSpeed
            } else if (clientY > rect.bottom - edge) {
                const dist = Math.max(0, clientY - (rect.bottom - edge))
                targetVel.current = Math.min(1, dist / edge) * maxSpeed
            } else {
                targetVel.current = 0
            }
            startLoop()
        },
        [scrollRef, edge, maxSpeed, startLoop],
    )

    const start = useCallback(() => {
        // 重置状态，避免上一次拖拽残留的速度/累加器影响本次起滚
        vel.current = 0
        targetVel.current = 0
        acc.current = 0
        active.current = true
    }, [])

    // 卸载兜底清理，避免遗留 rAF / 全局监听
    useEffect(() => () => stop(), [stop])

    return { start, stop, update }
}
