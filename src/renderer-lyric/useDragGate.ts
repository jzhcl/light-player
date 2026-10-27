import { useEffect, useRef, type RefObject } from 'react'
import { invoke } from '@renderer/lib/ipc'

/**
 * 让指定元素「抢走」窗口拖拽：指针停在它上面时，整窗拖拽关掉。
 *
 * 恢复时机的核心是：一次按下必须被完整地吞掉。
 * - 指针在元素外、左键已松开 → 恢复
 * - 指针离开元素时左键还按着 → 不恢复，一直压到松手为止
 *
 * `locked` 为真时一律禁用。
 */
export function useDragGate(ref: RefObject<HTMLElement | null>, locked: boolean): void {
    const lockedRef = useRef(locked)
    lockedRef.current = locked

    useEffect(() => {
        const el = ref.current
        if (!el) return

        /** 本地镜像主进程那边的开关，免得每次 pointermove 都白发一条 IPC */
        let disabled = false

        const setDrag = (enabled: boolean): void => {
            // 锁定是一票否决：指针在不在这个元素上都不作数
            const want = lockedRef.current ? false : enabled
            if (disabled === !want) return
            disabled = !want
            void invoke<boolean>('desktopLyricWindow:setDraggable', want)
        }

        const onEnter = (e: PointerEvent): void => {
            // 拖着窗口路过工具栏的，不算「要操作工具栏」——那一轮拖动不该中断
            if (e.buttons !== 0) return
            setDrag(false)
        }

        const onLeave = (e: PointerEvent): void => {
            // 还按着左键就先别恢复，等松手
            if (e.buttons === 0) setDrag(true)
        }

        /** 松手 / 在别处移动时的恢复判定，两条路径共用 */
        const restoreIfReleased = (e: PointerEvent): void => {
            if (e.buttons !== 0) return // 左键还按着
            if (el.contains(e.target as Node)) return // 指针仍停在工具栏上
            setDrag(true)
        }

        el.addEventListener('pointerenter', onEnter)
        el.addEventListener('pointerleave', onLeave)
        document.addEventListener('pointerup', restoreIfReleased)
        // 兜底：窗口外松手收不到 pointerup，指针移回窗口时靠这条恢复
        document.addEventListener('pointermove', restoreIfReleased)

        return () => {
            el.removeEventListener('pointerenter', onEnter)
            el.removeEventListener('pointerleave', onLeave)
            document.removeEventListener('pointerup', restoreIfReleased)
            document.removeEventListener('pointermove', restoreIfReleased)
            // 卸载后必须把拖拽还回去（绕开本地镜像），否则窗口再也拖不动
            void invoke<boolean>('desktopLyricWindow:setDraggable', true)
        }
    }, [ref])
}
