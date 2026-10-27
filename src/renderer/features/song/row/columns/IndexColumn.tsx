import { memo } from 'react'
import { Icon } from '@renderer/components/Icon'
import { player } from '@renderer/features/player/player'
import { usePlayerStore } from '@renderer/store'
import { Column } from './Column'

/**
 * 序号列。
 *
 * 三种常态（互斥，只渲染其一）+ 一种悬停态：
 *  - 非当前歌曲            → 序号
 *  - 当前歌曲且正在播放/加载 → 音频波形条
 *  - 当前歌曲但已暂停/停止   → 暂停图标（仅状态指示）
 *  - 鼠标进入行 / 行获得键盘焦点 → 换成按钮，图标按是否正在播放取胜（播放 / 暂停）
 */
export interface IndexColumnProps {
    /** 身份锚点：与 playerStore.currentSong 的 pluginId + pluginSongId 对齐 */
    pluginId: string
    pluginSongId: string
    /** 行序号（从 0 起），组件内自行 +1 */
    index: number
    /** 点击播放按钮：从该行开始播放（队列范围由页面决定） */
    onPlay?: (index: number) => void
}

function IndexColumnImpl({ pluginId, pluginSongId, index, onPlay }: IndexColumnProps) {
    const playState = usePlayerStore((s) =>
        s.currentSong?.pluginId === pluginId && s.currentSong?.pluginSongId === pluginSongId
            ? s.state
            : null,
    )
    const isCurrent = playState !== null
    const isActive = playState === 'playing' || playState === 'loading'

    return (
        <Column className="song-col--index">
            <span className="song-index-idle">
                {isActive ? (
                    <span className="wave" aria-hidden="true">
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                    </span>
                ) : isCurrent ? (
                    <Icon name="pause-fill" size={12} className="song-index-paused"/>
                ) : (
                    <span className="song-index">{index + 1}</span>
                )}
            </span>
            <button
                className="song-play-toggle"
                type="button"
                title={isActive ? '暂停' : '播放'}
                onClick={(e) => {
                    e.stopPropagation()
                    // 本行就是当前曲：按钮语义是「播放 / 暂停」开关，直接切当前曲，不走 onPlay
                    if (isCurrent) {
                        // 加载中不理：此时 play() 还在取链接，pause() 之后它仍会接着 play()，
                        // 既停不掉又可能重复取流，交给状态自然落定即可。
                        if (playState === 'loading') return
                        void player.togglePlay()
                        return
                    }
                    onPlay?.(index)
                }}
                onDoubleClick={(e) => e.stopPropagation()}
            >
                <Icon name={isActive ? 'pause-fill' : 'play'} size={12}/>
            </button>
        </Column>
    )
}

export const IndexColumn = memo(IndexColumnImpl)
