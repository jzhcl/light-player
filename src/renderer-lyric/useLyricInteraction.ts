import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@renderer/lib/ipc'

const LINE_SEL = '.lyric-line, .lyric-secondary'
const TOOLBAR_SEL = '.lyric-toolbar'

export interface LyricInteraction {
    /**
     * 激活态：进过「入口」且还没离开窗口。底色 / 边界 / 工具栏都由它驱动。
     */
    active: boolean
    locked: boolean
    toggleLock: () => void
}

/**
 * 桌面歌词窗的指针交互：穿透联动 + 锁定态。
 *
 * 激活态（决定底色/边界/工具栏的显隐）——
 * - 入口：未锁定时只认歌词热区（`LINE_SEL`：主歌词行 + 辅助行）；锁定后还认工具栏
 *   （此时它是唯一的解锁入口）
 * - 出口：只有离开窗口。中途移到窗口别处一律保持 —— 否则指针从歌词行挪向工具栏时
 *   会被中间那块空白打断，底色和工具栏一闪一灭
 *
 * 穿透——按锁定态分两套：
 * - 未锁定：跟着激活态走（进过歌词热区就不再穿透，直到离开窗口）
 * - 锁定：只跟着热区走（指针在 `LINE_SEL` / `.lyric-toolbar` 里才不穿透，移开就恢复）
 *   锁定时窗口本就该让位，只有那个解锁按钮值得接收点击
 *
 * 底色/边界额外要求未锁定：锁定的语义是「窗口别占地方」，只留一个按钮浮着。
 *
 * 能自己恢复靠的是 `setIgnoreMouseEvents(true, { forward: true })` 里的 forward：
 * 穿透之后系统仍把鼠标移动转发给页面，页面才知道指针回到了热区。
 */
export function useLyricInteraction(): LyricInteraction {
    const [active, setActive] = useState(false)
    const [locked, setLocked] = useState(false)

    /** 真相都放 ref 里同步维护 —— 事件回调里读 state 会读到上一轮的旧值 */
    const s = useRef({ active: false, locked: false, inHot: false })
    const throughRef = useRef(false)

    const syncThrough = useCallback((): void => {
        const cur = s.current
        const through = cur.locked ? !cur.inHot : !cur.active
        if (throughRef.current === through) return
        throughRef.current = through
        void invoke<boolean>('desktopLyricWindow:setMouseThrough', through)
    }, [])

    useEffect(() => {
        // 唯一的出口：离开窗口
        const onLeave = (): void => {
            s.current.active = false
            s.current.inHot = false
            setActive(false)
            syncThrough()
        }

        const onMove = (e: MouseEvent): void => {
            const el = e.target as HTMLElement | null
            const onLine = !!el?.closest(LINE_SEL)
            const onBar = !!el?.closest(TOOLBAR_SEL)

            s.current.inHot = onLine || onBar

            // 锁定后工具栏也是入口，指针直接落到按钮上就能把窗口唤起来
            const entered = onLine || (s.current.locked && onBar)
            if (entered && !s.current.active) {
                s.current.active = true
                setActive(true)
            }

            syncThrough()
        }

        document.addEventListener('mouseleave', onLeave)
        document.addEventListener('mousemove', onMove)

        return () => {
            document.removeEventListener('mouseleave', onLeave)
            document.removeEventListener('mousemove', onMove)
        }
    }, [syncThrough])

    const toggleLock = useCallback((): void => {
        const next = !s.current.locked
        s.current.locked = next
        // 切换那一刻指针必然正停在按钮上（也就是热区里）——直接算作已激活。
        // 少了这句：锁定瞬间工具栏会连同底色一起消失（此时 active 还是上一次的状态），
        // 用户刚点完锁定就看不到那个解锁按钮了；解锁瞬间则会立刻穿透，点不到旁边的按钮。
        s.current.active = s.current.inHot
        setLocked(next)
        setActive(s.current.active)
        // 穿透算法整个换了（未锁定看 active、锁定看 inHot），立刻按新算法重算
        syncThrough()
    }, [syncThrough])

    // 锁定后不允许拖动
    useEffect(() => {
        void invoke<boolean>('desktopLyricWindow:setDraggable', !locked)
    }, [locked])

    return { active, locked, toggleLock }
}
