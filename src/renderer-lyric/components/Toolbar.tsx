import { useRef } from 'react'
import { Icon } from '@renderer/components/Icon'
import { invoke } from '@renderer/lib/ipc'
import { TOPIC } from '@shared/topic'
import { useDragGate } from '../useDragGate'
import logoIcon from '@assets/images/logo-icon-round.png'

interface ToolbarProps {
    /** 播放态，决定中间那颗按钮是「播放」还是「暂停」 */
    playState: PlayState
    /** 是否已锁定：锁定后工具栏只剩解锁按钮 */
    locked: boolean
    onToggleLock: () => void
    /**
     * 工具栏当前是否可见
     */
    visible: boolean
}

/**
 * 桌面歌词窗工具栏。
 *
 * 按钮分两类去向：
 * - 播放控制发往主窗
 * - 窗口显隐直接 invoke 主进程
 *
 * 自身范围内没有拖拽：指针停在这里时整窗拖拽被关掉，见 useDragGate。
 * 显隐不在这里管 —— 由 .lyric-window 上的激活态/锁定类驱动，见 styles.css。
 */
export function Toolbar({ playState, locked, onToggleLock, visible }: ToolbarProps) {
    const ref = useRef<HTMLDivElement>(null)
    useDragGate(ref, locked)

    const isPlaying = playState === 'playing'

    /** 隐藏时一律不给 title */
    const tip = (text: string): string | undefined => (visible ? text : undefined)

    /** 转发给主窗执行的播放控制 */
    const control = (channel: 'control:prev' | 'control:playPause' | 'control:next') => () =>
        window.api.publish(TOPIC.MAIN, channel)

    return (
        <div ref={ref} className="lyric-toolbar">
            {locked ? (
                // 锁定态只留解锁入口：此时鼠标本该穿过窗口，多一个按钮就多一处误触
                <button className="lyric-toolbar-btn" title={tip('解锁')} onClick={onToggleLock}>
                    <Icon name="unlock"/>
                </button>
            ) : (
                <>
                    <button
                        className="lyric-toolbar-btn"
                        title={tip('显示主窗口')}
                        onClick={() => void invoke<boolean>('mainWindow:show')}
                    >
                        <img className="lyric-toolbar-logo" src={logoIcon} alt="" draggable={false}/>
                    </button>

                    <button className="lyric-toolbar-btn" title={tip('锁定')} onClick={onToggleLock}>
                        <Icon name="lock"/>
                    </button>

                    <span className="lyric-toolbar-divider"/>

                    <button className="lyric-toolbar-btn" title={tip('上一首')} onClick={control('control:prev')}>
                        <Icon name="prev"/>
                    </button>
                    <button
                        className="lyric-toolbar-btn"
                        title={tip(isPlaying ? '暂停' : '播放')}
                        onClick={control('control:playPause')}
                    >
                        <Icon name={isPlaying ? 'pause-fill' : 'play-fill'}/>
                    </button>
                    <button className="lyric-toolbar-btn" title={tip('下一首')} onClick={control('control:next')}>
                        <Icon name="next"/>
                    </button>

                    <span className="lyric-toolbar-divider"/>

                    <button
                        className="lyric-toolbar-btn lyric-toolbar-btn--danger"
                        title={tip('关闭桌面歌词')}
                        onClick={() => window.api.publish(TOPIC.MAIN, 'control:closeDesktopLyricWindow')}
                    >
                        <Icon name="x"/>
                    </button>
                </>
            )}
        </div>
    )
}
