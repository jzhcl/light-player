import { useEffect } from 'react'
import { invoke } from '@renderer/lib/ipc'

/** 八个缩放方向，与主进程的 ResizeDirection 对齐 */
type ResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/**
 * 桌面歌词窗的缩放：把渲染端的缩放区接到主进程的窗口矩形演算上。
 *
 * 为什么缩放由渲染端发起：无边框窗自带的边缘热区依赖系统的命中测试
 * （`WM_NCHITTEST` 返回 HTLEFT 之类），而窗口一旦 `setIgnoreMouseEvents(true)`
 * 就再拿不到鼠标消息，热区形同不存在。所以缩放区做在窗口内部、
 * 离真实边缘留一圈 padding —— 拖动过程中指针不会滑出窗口去触发 mouseleave。
 *
 * 按下即进入缩放模式；松手由两端各兜一次 —— 渲染端的 pointerup/pointercancel，
 * 以及主进程的 `WM_LBUTTONUP`（指针在窗口外松手时收不到 pointerup，靠它复位）。
 */
export function useResize(): void {
    useEffect(() => {
        const onDown = (e: PointerEvent): void => {
            const zone = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-resize]')
            if (!zone) return
            // 别让这次按下再触发别的默认行为
            e.preventDefault()
            void invoke<boolean>('desktopLyricWindow:startResize', zone.dataset.resize as ResizeDirection)
        }

        const onUp = (): void => {
            void invoke<boolean>('desktopLyricWindow:stopResize')
        }

        document.addEventListener('pointerdown', onDown)
        document.addEventListener('pointerup', onUp)
        document.addEventListener('pointercancel', onUp)

        return () => {
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('pointerup', onUp)
            document.removeEventListener('pointercancel', onUp)
        }
    }, [])
}
