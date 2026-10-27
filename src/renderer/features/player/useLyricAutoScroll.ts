import { useCallback, useEffect, useRef, type RefObject } from 'react'
import gsap from 'gsap'

/**
 * 歌词列表的自动居中跟随。
 *
 * 当前行落在容器高度的 30% 处，用 0.5s power2.inOut 补间过去。
 *
 * 三处「不打扰用户」的判据：
 *   1. 首行与末尾 3 行内不跟随：贴边时滚动反而在晃，而且目标位置会被夹取。
 *   2. 用户滚轮介入 → 立即停跟随，指针离开容器 3s 后恢复并立刻回到当前行。
 *   3. 暂停时不跟随，避免暂停后还自己动。
 */
export interface LyricAutoScrollOptions {
    scrollRef: RefObject<HTMLDivElement | null>
    /** 每行的元素，按显示行下标存；由列表的 ref 回调填充 */
    lineRefs: RefObject<(HTMLDivElement | null)[]>
    activeIndex: number
    total: number
    isPlaying: boolean
    /** 变化即重置（传歌曲 id）：滚动位置归零、跟随状态复位 */
    resetKey: string
}

export interface LyricAutoScrollHandlers {
    onWheel: () => void
    onMouseLeave: () => void
}

/** 当前行停在容器高度的 30% 处 */
const ACTIVE_ANCHOR = 0.3
/** 用户滚过之后多久恢复跟随 */
const RESUME_DELAY = 3000
/** 跟随补间时长（秒） */
const SCROLL_DURATION = 0.5
/** 跟随缓动 */
const SCROLL_EASE = 'power2.inOut'
/** 距首行 / 末行的安全边距：这个范围内不自动滚 */
const HEAD_MIN_INDEX = 1
const TAIL_MIN_REMAIN = 3

export function useLyricAutoScroll({
    scrollRef,
    lineRefs,
    activeIndex,
    total,
    isPlaying,
    resetKey,
}: LyricAutoScrollOptions): LyricAutoScrollHandlers {
    const userScrolling = useRef(false)
    const resumeTimer = useRef<number | null>(null)

    const clearResumeTimer = useCallback(() => {
        if (resumeTimer.current !== null) window.clearTimeout(resumeTimer.current)
        resumeTimer.current = null
    }, [])

    const scrollToLine = useCallback(
        (index: number) => {
            const el = scrollRef.current
            const line = lineRefs.current[index]
            if (!el || !line) return
            // 贴边区间不滚：否则每次行切换都会往反方向弹一下
            if (index < HEAD_MIN_INDEX || total - 1 - index < TAIL_MIN_REMAIN) return

            const target = Math.max(0, line.offsetTop - el.clientHeight * ACTIVE_ANCHOR)
            if (Math.abs(target - el.scrollTop) < 1) return

            gsap.killTweensOf(el)
            gsap.to(el, {
                scrollTop: target,
                duration: SCROLL_DURATION,
                ease: SCROLL_EASE,
                overwrite: true,
            })
        },
        [scrollRef, lineRefs, total],
    )

    // 顺序有意义：切歌复位必须排在「跟随」之前。两个 effect 在同一个 commit 里按声明
    // 顺序执行，而复位里有 `killTweensOf`——若它排在后头，会把同一 commit 里刚起的跟随
    // 补间一起杀掉，表现为「切歌后首行不居中」。
    //
    // 切歌 → 回到顶部并恢复跟随
    useEffect(() => {
        userScrolling.current = false
        clearResumeTimer()
        const el = scrollRef.current
        if (!el) return
        gsap.killTweensOf(el)
        el.scrollTop = 0
    }, [resetKey, scrollRef, clearResumeTimer])

    // 当前行变化 / 恢复播放 → 跟随。暂停中或用户正在滚时不打扰
    useEffect(() => {
        if (!isPlaying || userScrolling.current) return
        scrollToLine(activeIndex)
    }, [activeIndex, isPlaying, scrollToLine])

    // 卸载兜底：补间是挂在 DOM 上的，不清掉会在组件消失后继续滚
    useEffect(
        () => () => {
            const el = scrollRef.current
            if (el) gsap.killTweensOf(el)
        },
        [scrollRef],
    )

    useEffect(() => clearResumeTimer, [clearResumeTimer])

    const onWheel = useCallback(() => {
        userScrolling.current = true
        clearResumeTimer()
    }, [clearResumeTimer])

    const onMouseLeave = useCallback(() => {
        if (!userScrolling.current) return
        clearResumeTimer()
        resumeTimer.current = window.setTimeout(() => {
            userScrolling.current = false
            resumeTimer.current = null
            // 播放中时立刻回到当前行，不必等下一行切换
            if (isPlaying) scrollToLine(activeIndex)
        }, RESUME_DELAY)
    }, [activeIndex, clearResumeTimer, isPlaying, scrollToLine])

    return { onWheel, onMouseLeave }
}
