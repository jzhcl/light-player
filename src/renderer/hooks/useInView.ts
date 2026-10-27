import { useEffect, type RefObject } from 'react'

/**
 * 元素进入视口时执行回调（IntersectionObserver 的薄封装）
 */
export interface UseInViewOptions {
    /** 相交判定的根容器，默认浏览器视口；自带滚动容器时传该容器 */
    root?: Element | null
    /**
     * 根容器的外扩 / 内缩，CSS margin 语法（'0px 0px 100px 0px' = 底部外扩 100px）。
     * 数字等价于四边统一 px。
     */
    rootMargin?: number | string
    /** 相交比例阈值（0~1），默认 0 —— 露出一个像素即算进入 */
    threshold?: number
    /** 为 true 时断开观察 */
    disabled?: boolean
    /** 该值变化时重建 observer。新建的 observer 会立即上报一次当前相交状态 */
    reobserveOn?: unknown
}

export function useInView(
    ref: RefObject<Element | null>,
    onInView: () => void,
    { root = null, rootMargin = 0, threshold = 0, disabled = false, reobserveOn }: UseInViewOptions = {},
): void {
    useEffect(() => {
        const el = ref.current
        if (disabled || !el) return

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some((e) => e.isIntersecting)) onInView()
            },
            {
                root,
                rootMargin: typeof rootMargin === 'number' ? `${rootMargin}px` : rootMargin,
                threshold,
            },
        )
        observer.observe(el)
        return () => observer.disconnect()
    }, [ref, onInView, root, rootMargin, threshold, disabled, reobserveOn])
}
