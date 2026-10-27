import React, {
    useCallback,
    useEffect,
    useRef,
    type ReactNode,
    type Ref,
} from 'react'

// 自定义滚动区：原生滚动容器 + 绝对定位滑块（避免占位抖动）。
// 滑块支持「悬停/滚动显示、停滞后淡出、拖拽滚动」，几何随内容高度自动重算。
// 通过 scrollRef 把内部滚动元素转发给父组件。
export interface ScrollAreaProps {
    children: ReactNode
    /** 外层包裹层的场景增量类名；基础类 `.scroll-area` */
    className?: string
    /** 滚动视口的场景增量类名；基础类 `.scroll-area-view` */
    scrollClassName?: string
    /** 滑块的场景增量类名；基础类 `.scroll-area-thumb` */
    thumbClassName?: string
    /** 显示触发方式：'hover' 悬停/滚动时显示；'none' 始终显示 */
    trigger?: 'none' | 'hover'
    /** hover 模式下是否自动隐藏（淡出）。false 时仅悬停显示、不淡出 */
    autoHide?: boolean
    /** 自动隐藏延迟（毫秒） */
    hideDelay?: number
    /** 内容高度变化时需要重算滑块几何的依赖 */
    deps?: React.DependencyList
    /** 转发内部滚动元素 ref，供父组件直接驱动滚动 */
    scrollRef?: Ref<HTMLDivElement>
}

const MIN_THUMB = 24 // 滑块最小高度，避免内容极长时滑块无限缩小
const NO_OVERFLOW = 1 // 容差：scrollHeight <= clientHeight + 1 视为无溢出

/** 拼类名：基础类恒在，场景增量可选 */
const cx = (base: string, extra?: string) => (extra ? `${base} ${extra}` : base)

export function ScrollArea({
    children,
    className,
    scrollClassName,
    thumbClassName,
    trigger = 'hover',
    autoHide = true,
    hideDelay = 800,
    deps = [],
    scrollRef,
}: ScrollAreaProps) {
    const wrapRef = useRef<HTMLDivElement | null>(null)
    const innerRef = useRef<HTMLDivElement | null>(null)
    const thumbRef = useRef<HTMLDivElement | null>(null)
    const visibleRef = useRef(false)
    const hideTimer = useRef<number | null>(null)
    const hoveringThumb = useRef(false)
    const thumbDrag = useRef<{ active: boolean; startY: number; startTop: number } | null>(null)

    const setScrollRef = useCallback(
        (el: HTMLDivElement | null) => {
            innerRef.current = el
            if (typeof scrollRef === 'function') scrollRef(el)
            else if (scrollRef) scrollRef.current = el
        },
        [scrollRef],
    )

    /**
     * 按当前 scrollTop 重算滑块几何并写进 DOM；未溢出则收起滑块。
     * @returns 是否存在溢出（即滑块此时是否「有东西可显示」）
     */
    const paint = useCallback(() => {
        const el = innerRef.current
        const thumb = thumbRef.current
        if (!el || !thumb) return false
        const { scrollTop, scrollHeight, clientHeight } = el
        if (scrollHeight <= clientHeight + NO_OVERFLOW) {
            if (visibleRef.current) {
                visibleRef.current = false
                thumb.classList.remove('is-visible')
            }
            return false
        }
        const maxScroll = scrollHeight - clientHeight
        const height = Math.max(MIN_THUMB, (clientHeight / scrollHeight) * clientHeight)
        const top = maxScroll > 0 ? (scrollTop / maxScroll) * (clientHeight - height) : 0
        thumb.style.height = `${height}px`
        thumb.style.top = `${top}px`
        return true
    }, [])

    const clearHideTimer = useCallback(() => {
        if (hideTimer.current) {
            window.clearTimeout(hideTimer.current)
            hideTimer.current = null
        }
    }, [])

    /** 显示滑块 */
    const reveal = useCallback(() => {
        clearHideTimer()
        const thumb = thumbRef.current
        if (thumb && !visibleRef.current) {
            visibleRef.current = true
            thumb.classList.add('is-visible')
        }
    }, [clearHideTimer])

    const hide = useCallback(() => {
        const thumb = thumbRef.current
        if (thumb && visibleRef.current) {
            visibleRef.current = false
            thumb.classList.remove('is-visible')
        }
    }, [])

    /** 量几何后显示 */
    const show = useCallback(() => {
        if (!paint()) return
        reveal()
    }, [paint, reveal])

    // 进入自动隐藏倒计时；拖拽中或正悬停滑块时不隐藏；trigger='none' 永不隐藏
    const scheduleHide = useCallback(() => {
        if (trigger === 'none') return
        clearHideTimer()
        hideTimer.current = window.setTimeout(() => {
            if (thumbDrag.current?.active || hoveringThumb.current) return
            hide()
        }, hideDelay)
    }, [clearHideTimer, hide, trigger, hideDelay])

    // 滚动：显示并同步几何，随后进入自动隐藏计时
    const onScroll = useCallback(() => {
        if (!paint()) return
        reveal()
        scheduleHide()
    }, [paint, reveal, scheduleHide])

    /**
     * 进入滚动区。
     * autoHide 模式（默认）下什么都不做：单纯悬停并不显示滑块，几何留到滚动
     * 或真正要显示时再量
     */
    const onWrapEnter = useCallback(() => {
        if (trigger === 'none' || autoHide) return
        show()
    }, [trigger, autoHide, show])

    // 离开滚动区：进入自动隐藏计时（拖拽 / 悬停滑块时由各自守卫拦截）
    const onWrapLeave = useCallback(() => {
        if (trigger === 'none') return
        scheduleHide()
    }, [scheduleHide, trigger])

    useEffect(() => {
        const el = wrapRef.current
        if (!el) return
        el.addEventListener('mouseenter', onWrapEnter)
        el.addEventListener('mouseleave', onWrapLeave)
        return () => {
            el.removeEventListener('mouseenter', onWrapEnter)
            el.removeEventListener('mouseleave', onWrapLeave)
        }
    }, [onWrapEnter, onWrapLeave])

    // 悬停滑块：始终显示并取消隐藏计时（autoHide 模式下这是「悬停滑块显示」的来源）
    const onThumbEnter = useCallback(() => {
        hoveringThumb.current = true
        show()
    }, [show])

    const onThumbLeave = useCallback(() => {
        hoveringThumb.current = false
        scheduleHide()
    }, [scheduleHide])

    // 滑块拖拽：直接驱动 scrollTop，原生滚动保证平滑
    const onThumbPointerMove = useCallback((e: PointerEvent) => {
        const el = innerRef.current
        const drag = thumbDrag.current
        if (!el || !drag?.active) return
        const ratio = el.scrollHeight / el.clientHeight
        el.scrollTop = drag.startTop + (e.clientY - drag.startY) * ratio
    }, [])

    const onThumbPointerUp = useCallback(() => {
        thumbDrag.current = null
        window.removeEventListener('pointermove', onThumbPointerMove)
        window.removeEventListener('pointerup', onThumbPointerUp)
        scheduleHide()
    }, [onThumbPointerMove, scheduleHide])

    const onThumbPointerDown = useCallback(
        (e: React.PointerEvent) => {
            e.preventDefault()
            e.stopPropagation()
            const el = innerRef.current
            if (!el) return
            thumbDrag.current = { active: true, startY: e.clientY, startTop: el.scrollTop }
            show()
            clearHideTimer()
            window.addEventListener('pointermove', onThumbPointerMove)
            window.addEventListener('pointerup', onThumbPointerUp)
        },
        [onThumbPointerMove, onThumbPointerUp, show, clearHideTimer],
    )

    // 内容高度变化（deps）或挂载时重算几何；
    // trigger='none' 时同步可见性，hover 模式不改变可见性（仅滚动/悬停触发）
    useEffect(() => {
        const overflow = paint()
        if (trigger === 'none') {
            if (overflow) reveal()
            else hide()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)

    useEffect(
        () => () => {
            clearHideTimer()
            window.removeEventListener('pointermove', onThumbPointerMove)
            window.removeEventListener('pointerup', onThumbPointerUp)
        },
        [onThumbPointerMove, onThumbPointerUp, clearHideTimer],
    )

    return (
        <div className={cx('scroll-area', className)} ref={wrapRef}>
            <div className={cx('scroll-area-view', scrollClassName)} ref={setScrollRef} onScroll={onScroll}>
                {children}
            </div>
            <div
                className={cx('scroll-area-thumb', thumbClassName)}
                ref={thumbRef}
                onPointerDown={onThumbPointerDown}
                onMouseEnter={onThumbEnter}
                onMouseLeave={onThumbLeave}
            />
        </div>
    )
}
