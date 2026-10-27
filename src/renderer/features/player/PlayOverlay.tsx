import { useEffect } from 'react'
import { Icon } from '@renderer/components/Icon'
import { usePlayOverlayStore } from '@renderer/store'
import { PlayView } from './PlayView'

/**
 * 播放页浮层外壳。
 */
export function PlayOverlay() {
    const visible = usePlayOverlayStore((s) => s.visible)
    const close = usePlayOverlayStore((s) => s.close)

    useEffect(() => {
        if (!visible) return
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') close()
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [visible, close])

    if (!visible) return null

    return (
        <div className="play-overlay" role="dialog" aria-modal="true" aria-label="播放详情">
            {/* 浮层盖住了标题栏，所以顶部这条自己承担拖动窗口 + 收起 */}
            <div className="play-overlay-bar draggable">
                <button
                    className="icon-button no-draggable center"
                    type="button"
                    title="收起（Esc）"
                    aria-label="收起播放详情"
                    onClick={close}
                >
                    <Icon name="x" size={18}/>
                </button>
            </div>

            <PlayView/>
        </div>
    )
}
