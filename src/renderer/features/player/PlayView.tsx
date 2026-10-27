import { useCallback, useState } from 'react'
import { formatPlayTime } from '@shared/format'
import type { IconName } from '@assets/icons'
import { Icon } from '@renderer/components/Icon'
import { Cover } from '@renderer/components/ui/Cover'
import { Slider } from '@renderer/components/ui/Slider'
import { useCurrentSongLike } from '@renderer/features/song/useCurrentSongLike'
import { usePlayerStore, useSettingsStore } from '@renderer/store'
import { LyricScrollList } from './LyricScrollList'
import { VolumeKnob } from './VolumeKnob'
import { NEXT_MODE, player } from './player'

/**
 * 播放详情页主体。
 *
 * 左栏 43% 从上到下依次是：唱盘 → 容器A（信息 + 喜欢）→ 进度条 → 容器B（模式 | 上一首/播放/下一首 | 音量）；
 * 右栏 57% 是歌词列表。
 *
 * 层序即绘制顺序：`.play-bg` → `.play-veil` → `.play-body`。
 */
export function PlayView() {
    const currentSong = usePlayerStore((s) => s.currentSong)
    const currentTime = usePlayerStore((s) => s.currentTime)
    const duration = usePlayerStore((s) => s.duration)
    const playState = usePlayerStore((s) => s.state)
    const mode = useSettingsStore((s) => s.settings['player.mode'])
    const { isLiked, toggle: toggleLike } = useCurrentSongLike()

    // 拖拽中走本地草稿值、松手才 seek
    const [seeking, setSeeking] = useState<number | null>(null)
    const displayTime = seeking ?? currentTime
    const canSeek = !!currentSong && duration > 0 && playState !== 'loading'
    const isPlaying = playState === 'playing'

    const toggleMode = useCallback(() => {
        player.setMode(NEXT_MODE[mode])
    }, [mode])

    const artist = currentSong?.singer || '未知艺术家'
    const subtitle = currentSong?.album ? `${artist} · ${currentSong.album}` : artist

    // 图标名与模式同名
    const modeIcon: IconName = mode
    const modeTitle = mode === 'single' ? '单曲循环' : mode === 'random' ? '随机播放' : '列表循环'

    return (
        <div className={`play-view${isPlaying ? ' is-playing' : ''}`}>
            {/* 背景层：封面放大 + 模糊。低清封面放大到满屏会糊成马赛克，blur 之后只剩色调做氛围。
                没有封面时整层不渲染，靠罩层的实色兜底。 */}
            {currentSong?.pic && (
                <div className="play-bg">
                    <Cover pic={currentSong.pic} className="play-bg-img"/>
                </div>
            )}

            {/* 罩层：背景可能很亮也可能很暗，统一压一层才能保证文字一直是可读的 */}
            <div className="play-veil"/>

            <div className="play-body">
                <div className="play-left">
                    {/* 唱盘 */}
                    <div className="play-disc-wrap">
                        <div className="play-disc">
                            {/* 内环混色：封面圆窗外那一圈铺同一张图（重度模糊 + 径向遮罩），环的颜色由封面决定。 */}
                            <div className="play-disc-tint">
                                <Cover pic={currentSong?.pic} className="play-disc-tint-img"/>
                            </div>

                            <div className="play-disc-cover">
                                <Cover pic={currentSong?.pic} className="play-disc-cover-img"/>
                            </div>
                        </div>

                        {/* 高光：与盘同格的兄弟层，不随盘旋转 */}
                        <div className="play-disc-sheen"/>
                    </div>

                    {/* 容器A：左侧歌名 / 歌手·专辑，右侧喜欢 */}
                    <div className="play-meta">
                        <div className="play-meta-text">
                            <span className="play-name ellipsis" title={currentSong?.name}>
                                {currentSong?.name ?? '未播放歌曲'}
                            </span>
                            <span className="play-sub ellipsis" title={subtitle}>
                                {subtitle}
                            </span>
                        </div>

                        <button
                            className={`play-button${isLiked ? ' is-active' : ''}`}
                            type="button"
                            title={isLiked ? '取消喜欢' : '喜欢'}
                            aria-label={isLiked ? '取消喜欢' : '喜欢'}
                            disabled={!currentSong}
                            onClick={toggleLike}
                        >
                            <Icon name={isLiked ? 'heart-fill' : 'heart'} size={16}/>
                        </button>
                    </div>

                    {/* 进度条 */}
                    <div className="play-timeline">
                        <span className="play-time">{formatPlayTime(displayTime)}</span>

                        <Slider
                            className="play-progress"
                            value={displayTime}
                            min={0}
                            max={duration > 0 ? duration : 1}
                            step={1}
                            disabled={!canSeek}
                            autoHideThumb
                            ariaLabel="播放进度"
                            onChange={(v) => {
                                if (canSeek) setSeeking(v)
                            }}
                            onCommit={(v) => {
                                if (!canSeek) return
                                player.seekTo(v)
                                setSeeking(null)
                            }}
                        />

                        <span className="play-time">{formatPlayTime(duration)}</span>
                    </div>

                    {/* 容器B：左 = 播放模式，中 = 上一首/播放暂停/下一首，右 = 音量旋钮 */}
                    <div className="play-controls">
                        <button
                            className="play-button"
                            type="button"
                            title={modeTitle}
                            aria-label={`播放模式：${modeTitle}`}
                            onClick={toggleMode}
                        >
                            <Icon name={modeIcon} size={16}/>
                        </button>

                        <div className="play-controls-center">
                            <button
                                className="play-button"
                                type="button"
                                title="上一首"
                                aria-label="上一首"
                                onClick={() => void player.playPrev()}
                            >
                                <Icon name="prev" size={18}/>
                            </button>

                            <button
                                className="play-button play-button--play"
                                type="button"
                                title={playState === 'loading' ? '加载中…' : isPlaying ? '暂停' : '播放'}
                                aria-label={playState === 'loading' ? '加载中' : isPlaying ? '暂停' : '播放'}
                                disabled={playState === 'loading'}
                                onClick={() => void player.togglePlay()}
                            >
                                <Icon name={isPlaying ? 'pause-fill' : 'play-fill'} size={20}/>
                            </button>

                            <button
                                className="play-button"
                                type="button"
                                title="下一首"
                                aria-label="下一首"
                                onClick={() => void player.playNext()}
                            >
                                <Icon name="next" size={18}/>
                            </button>
                        </div>

                        <VolumeKnob/>
                    </div>
                </div>

                <div className="play-lyric-col">
                    <LyricScrollList/>
                </div>
            </div>
        </div>
    )
}
