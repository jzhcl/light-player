
import { useEffect } from 'react'
import { invoke } from '@renderer/lib/ipc'

/** 按下这两类元素时不拖窗口：缩放区自己接管按下，工具栏是按钮区 */
const NO_MOVE_SEL = '[data-resize], .lyric-toolbar'

/**
 * 只有 macOS 需要渲染端驱动拖拽：那边没有 Windows 的 `WM_LBUTTONDOWN` / `WM_MOUSEMOVE`
 * 可挂（见 main/utils/draggable.ts），主进程只能靠「渲染端告知起止 + 自己轮询光标」来挪窗口。
 */
const RENDERER_DRIVEN_MOVE = window.env.platform === 'darwin'

/**
 * 桌面歌词窗的整窗拖拽：把渲染端的按下/松手告诉主进程。
 *
 * 松手要在多条路径上都收一次：指针移出窗口时的 pointerup 最不可靠，
 * 漏了会让主进程一直跟着光标跑（那边另有 15s 硬上限兜底）。
 */
export function useMove(): void {
    useEffect(() => {
        if (!RENDERER_DRIVEN_MOVE) return

        // 只有真的起过拖拽才需要收尾：普通点击（按钮、缩放区）不发无用 IPC
        let dragging = false

        const onDown = (e: PointerEvent): void => {
            if (e.button !== 0) return
            const el = e.target as HTMLElement | null
            if (el?.closest(NO_MOVE_SEL)) return
            dragging = true
            void invoke<boolean>('desktopLyricWindow:startMove')
        }

        const onUp = (): void => {
            if (!dragging) return
            dragging = false
            void invoke<boolean>('desktopLyricWindow:stopMove')
        }

        document.addEventListener('pointerdown', onDown)
        document.addEventListener('pointerup', onUp)
        document.addEventListener('pointercancel', onUp)
        // 窗口失焦（切到别的应用）时不会有 pointerup 跟过来
        window.addEventListener('blur', onUp)

        return () => {
            document.removeEventListener('pointerdown', onDown)
            document.removeEventListener('pointerup', onUp)
            document.removeEventListener('pointercancel', onUp)
            window.removeEventListener('blur', onUp)
        }
    }, [])
}