import { useCallback, useEffect, useRef, useState } from 'react'
import type { IconName } from '@assets/icons'
import { LP_EVENT } from '@shared/event'
import { formatPlayTime, qualityLabel, qualityShortLabel } from '@shared/format'
import { Icon } from '@renderer/components/Icon'
import { Cover } from '@renderer/components/ui/Cover'
import { Popover } from '@renderer/components/ui/Popover'
import { Slider } from '@renderer/components/ui/Slider'
import { invoke } from '@renderer/lib/ipc'
import { useCurrentSongLike } from '@renderer/features/song/useCurrentSongLike'
import { QueuePanel } from '@renderer/features/queue/QueuePanel'
import { useLyricView } from '@renderer/features/lyrics/useLyricView'
import { resolveActiveLineIndex } from '@renderer/features/lyrics/position'
import { useIsPlaying, usePlayOverlayStore, usePlayerStore, useQueueStore, useSettingsStore } from '@renderer/store'
import { NEXT_MODE, player, type QueueEntry } from '@renderer/features/player/player'
import { describeQualityGap, displayQuality } from '@renderer/features/player/resolveQuality'
import { ALL_QUALITIES } from '@renderer/lib/constants'
import { rlog } from '@renderer/lib/log'


/**
 * 底部播放控制栏。
 *
 * 布局三段：左=封面 + 歌曲信息 + 喜欢；中=歌词预览 + 时间读数；右=播放控制与工具。
 * 进度条不整条底栏的顶边，兼任那条 1px 分隔线。中栏只留「02:05 / 04:31」一行读数。
 *
 * 进度用「拖拽中走本地草稿值、松手才 seek」：直接把 currentTime 交给受控滑块，
 * 会在拖动途中被 timeupdate 反复覆盖，手感是「拖不动」。
 *
 * 音量收进悬停浮层：按钮本身点击仍是静音，悬停才弹滑块。
 */

/**
 * 底栏的「当前音质」：常显的短标签，点开是音质面板。
 * 内容按「事实 → 算出 → 设置」三级取（见 `displayQuality`）；面板改的是全局首选音质。
 */
function QualityPanel() {
    const currentSong = usePlayerStore((s) => s.currentSong)
    const playbackQuality = usePlayerStore((s) => s.currentPlaybackQuality)
    const preferred = useSettingsStore((s) => s.settings['player.preferredQuality'])
    const anchorRef = useRef<HTMLButtonElement>(null)
    const [open, setOpen] = useState(false)
    const [switching, setSwitching] = useState<Quality | null>(null)
    const busyRef = useRef(false)

    // 事实（引擎已装载的档）→ 有歌时按首选算出的档 → 无歌时的全局首选
    const shown = displayQuality(currentSong, playbackQuality, preferred)
    const supported = new Set((currentSong?.supportQualities ?? []).map((q) => q.type))
    // 事实区只在引擎真的装载过流时才陈述 —— 未装载时 store 里是 null
    const fact = playbackQuality
    const hint = currentSong ? describeQualityGap(currentSong, preferred) : null

    /**
     * 选档：先写全局偏好（面板才是「设置」的入口），再让播放引擎按新偏好对当前歌重取一次流
     */
    const choose = async (quality: Quality): Promise<void> => {
        if (busyRef.current || quality === preferred) return
        busyRef.current = true
        setSwitching(quality)
        try {
            useSettingsStore.getState().setSetting('player.preferredQuality', quality)
            rlog.info(`[player] 控制栏切换首选音质 ${preferred} → ${quality}`)
            await player.reload()
        } finally {
            busyRef.current = false
            setSwitching(null)
        }
    }

    return (
        <Popover
            open={open}
            onOpenChange={setOpen}
            side="top"
            autoFocus={false}
            anchorRef={anchorRef}
            arrow={false}
            className="control-quality-popover popover--bare"
            anchor={
                <button
                    ref={anchorRef}
                    type="button"
                    className="control-quality"
                    title={`${currentSong ? '当前音质' : '首选音质'} ${qualityLabel(shown)}（点击切换，对所有歌曲生效）`}
                    aria-label={`当前音质 ${qualityLabel(shown)}`}
                    aria-haspopup="true"
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                >
                    {qualityShortLabel(shown)}
                </button>
            }
        >
            <div className="control-quality-panel" role="group" aria-label="播放音质偏好">
                <div className="control-quality-head">
                    <span className="control-quality-title">播放音质偏好</span>
                    {/* 事实区：与列表的 ✓（设置值）是两条轴，分开放 */}
                    {fact ? (
                        <p className="control-quality-now">
                            <span className="control-quality-now-label">正在播放</span>
                            <span className="control-quality-now-value">{qualityLabel(fact)}</span>
                        </p>
                    ) : null}
                    {hint ? <p className="control-quality-hint">{hint}</p> : null}
                </div>
                {ALL_QUALITIES.map((q) => {
                    const isPreferred = q === preferred
                    const isSwitching = switching === q
                    // 没有歌时无从判断「哪一档拿不到」→ 一个都不标不可用
                    const unavailable = currentSong ? !supported.has(q) : false
                    return (
                        <button
                            key={q}
                            type="button"
                            className={
                                'control-quality-option' +
                                (isPreferred ? ' is-preferred' : '') +
                                (unavailable ? ' is-unavailable' : '')
                            }
                            aria-pressed={isPreferred}
                            disabled={isSwitching}
                            onClick={() => void choose(q)}
                        >
                            <span className="control-quality-option-name">{qualityLabel(q)}</span>
                            {/* 换档中的转圈只是进度指示，落位即消失。
                                放在 ✓ 左边：✓ 靠行尾锚定，转圈出现/消失不会推着它动。 */}
                            {isSwitching ? (
                                <span className="control-quality-option-spin">
                                    <Icon name="refresh" size={13}/>
                                </span>
                            ) : null}
                            {/* 行尾槽：全局首选（设置值） */}
                            <span className="control-quality-option-check">
                                {isPreferred ? <Icon name="check-circle" size={14}/> : null}
                            </span>
                        </button>
                    )
                })}
            </div>
        </Popover>
    )
}

/**
 * 时间轴（读数 + 进度条）
 * 拖拽草稿值（seeking）是本地的，松手才 seek。
 */
function Timeline() {
    const currentTime = usePlayerStore((s) => s.currentTime)
    const duration = usePlayerStore((s) => s.duration)
    const currentSong = usePlayerStore((s) => s.currentSong)
    const playState = usePlayerStore((s) => s.state)
    const { seekTo } = player

    // 拖拽中的草稿时间：非 null 时接管显示。松手才 seek
    const [seeking, setSeeking] = useState<number | null>(null)
    const displayTime = seeking ?? currentTime
    const canSeek = !!currentSong && duration > 0 && playState !== 'loading'

    return (
        <div className="control-timeline">
            <span className="control-time is-start">{formatPlayTime(displayTime)}</span>

            {/* 进度轨：绝对定位脱出本容器、贴到 .control 顶边。
                圆点自动隐藏：只有悬停底栏 / 拖拽 / 键盘聚焦时显形。 */}
            <Slider
                className="control-progress"
                value={displayTime}
                min={0}
                max={duration > 0 ? duration : 1}
                step={1}
                disabled={!canSeek}
                autoHideThumb
                ariaLabel="播放进度"
                onChange={(v) => {
                    if (!canSeek) return
                    setSeeking(v)
                }}
                onCommit={(v) => {
                    if (!canSeek) return
                    seekTo(v)
                    setSeeking(null)
                }}
            />

            <span className="control-time is-end">{formatPlayTime(duration)}</span>
        </div>
    )
}

/**
 * 控制栏歌词预览。
 */
function LyricPreview() {
    const { lines: lyricLines, activeIndex } = useLyricView()
    // 间奏（空行）不能空着 —— 解析成「应显示的那一行」
    const lyricLine = lyricLines[resolveActiveLineIndex(lyricLines, activeIndex)]?.text ?? ''

    return (
        <div className="control-lyric">
            <span className="control-lyric-text ellipsis">{lyricLine}</span>
        </div>
    )
}

export function Control() {
    const isPlaying = useIsPlaying()
    const currentSong = usePlayerStore((s) => s.currentSong)
    const volume = useSettingsStore((s) => s.settings['player.audio.volume'])
    const mode = useSettingsStore((s) => s.settings['player.mode'])
    const queue = useQueueStore((s) => s.queue) as QueueEntry[]
    const { togglePlay, playPrev, playNext, setVolume, setMode } = player
    const playState = usePlayerStore((s) => s.state)
    const showLyricPreview = useSettingsStore((s) => s.settings['appearance.control.showLyricPreview'])
    const openPlayOverlay = usePlayOverlayStore((s) => s.open)

    // 静音需要能还原到静音前的音量
    const lastVolumeRef = useRef(volume > 0 ? volume : 0.6)
    useEffect(() => {
        if (volume > 0) lastVolumeRef.current = volume
    }, [volume])

    // 喜欢状态与切换
    const { toggle: toggleLike } = useCurrentSongLike()

    const toggleMode = useCallback(() => {
        setMode(NEXT_MODE[mode])
    }, [mode, setMode])

    const toggleMute = useCallback(() => {
        setVolume(volume > 0 ? 0 : lastVolumeRef.current)
    }, [volume, setVolume])

    // 桌面歌词窗开关
    const [lyricShown, setLyricShown] = useState(false)
    useEffect(
        () => window.api.on(LP_EVENT['DESKTOP_LYRIC.STATE'], (open) => setLyricShown(open === true)),
        [],
    )

    const toggleDesktopLyric = useCallback(() => {
        void invoke('mainWindow:toggleLyric')
    }, [])

    // ---- 音量浮层的悬停开合 ----
    // 按钮与浮层是两棵 DOM（浮层 Portal 到 body），所以只能靠「离开时延迟收 + 进入时取消延迟」接力。
    const [volumeOpen, setVolumeOpen] = useState(false)
    const volumeAnchorRef = useRef<HTMLButtonElement | null>(null) // 触发按钮；交给 Popover 排除在「外部交互」之外
    const volumeOpenTimer = useRef<number | null>(null)
    const volumeCloseTimer = useRef<number | null>(null)
    const volumeHoverRef = useRef(false) // 指针当前是否在浮层里
    const volumeHeldRef = useRef(false) // 是否正在拖滑块

    const clearVolumeTimers = useCallback(() => {
        if (volumeOpenTimer.current !== null) window.clearTimeout(volumeOpenTimer.current)
        if (volumeCloseTimer.current !== null) window.clearTimeout(volumeCloseTimer.current)
        volumeOpenTimer.current = null
        volumeCloseTimer.current = null
    }, [])

    useEffect(() => clearVolumeTimers, [clearVolumeTimers])

    const scheduleVolumeOpen = useCallback(() => {
        clearVolumeTimers()
        volumeOpenTimer.current = window.setTimeout(() => setVolumeOpen(true), 200)
    }, [clearVolumeTimers])

    const scheduleVolumeClose = useCallback(() => {
        clearVolumeTimers()
        volumeCloseTimer.current = window.setTimeout(() => setVolumeOpen(false), 300)
    }, [clearVolumeTimers])

    const handleVolumeEnter = useCallback(() => {
        volumeHoverRef.current = true
        clearVolumeTimers()
    }, [clearVolumeTimers])

    const handleVolumeLeave = useCallback(() => {
        volumeHoverRef.current = false
        // 拖拽时指针常常已经拖出浮层，这时不能收 —— 交给松手时补收
        if (volumeHeldRef.current) return
        scheduleVolumeClose()
    }, [scheduleVolumeClose])

    const holdVolume = useCallback(() => {
        volumeHeldRef.current = true
        clearVolumeTimers()
    }, [clearVolumeTimers])

    const releaseVolume = useCallback(() => {
        volumeHeldRef.current = false
        // 松手时指针已经在层外才收（还在层里就等 mouseleave）
        if (!volumeHoverRef.current) scheduleVolumeClose()
    }, [scheduleVolumeClose])

    // ---- 音量滚轮调节（锚点按钮 + 浮层面板两处）----
    const handleVolumeWheel = useCallback(
        (e: WheelEvent) => {
            e.preventDefault()
            // 向下滚是减小。在整数百分比上加减，避免浮点累积成 0.7000000000000001
            const step = e.deltaY > 0 ? -5 : 5
            setVolume((Math.round(volume * 100) + step) / 100)
        },
        [volume, setVolume],
    )

    const bindVolumePanelWheel = useCallback(
        (el: HTMLDivElement | null) => {
            el?.addEventListener('wheel', handleVolumeWheel, { passive: false })
            return () => el?.removeEventListener('wheel', handleVolumeWheel)
        },
        [handleVolumeWheel],
    )

    // 锚点按钮是常驻 DOM（不在浮层里），普通 effect 就够
    useEffect(() => {
        const el = volumeAnchorRef.current
        if (!el) return
        el.addEventListener('wheel', handleVolumeWheel, { passive: false })
        return () => el.removeEventListener('wheel', handleVolumeWheel)
    }, [handleVolumeWheel])

    // 音量百分比
    const volumePct = Math.round(volume * 100)

    const modeIcon: IconName = mode
    const modeTitle = mode === 'single' ? '单曲循环' : mode === 'random' ? '随机播放' : '列表循环'

    const hasQueue = queue.length > 0

    return (
        <div className="control">
            <div className="control-left">
                <button
                    className="control-cover"
                    type="button"
                    title="播放详情"
                    aria-label="播放详情"
                    onClick={openPlayOverlay}
                >
                    <Cover pic={currentSong?.pic} className="control-cover-img"/>
                </button>

                <div className="control-info">
                    <span className="control-name ellipsis" title={currentSong?.name}>
                        {currentSong?.name ?? '未播放歌曲'}
                    </span>
                    <span className="control-artist ellipsis" title={currentSong?.singer}>
                        {currentSong?.singer || '未知艺术家'}
                    </span>
                </div>

                <button
                    className={`control-button control-button--like${currentSong?.isLiked ? ' is-active' : ''}`}
                    type="button"
                    title={currentSong?.isLiked ? '取消喜欢' : '喜欢'}
                    aria-label={currentSong?.isLiked ? '取消喜欢' : '喜欢'}
                    disabled={!currentSong}
                    onClick={toggleLike}
                >
                    <Icon name={currentSong?.isLiked ? 'heart-fill' : 'heart'} size={16}/>
                </button>
            </div>

            <div className="control-center">
                {showLyricPreview && <LyricPreview />}

                <Timeline />
            </div>

            <div className="control-right">
                <button
                    className="control-button"
                    type="button"
                    title="上一首"
                    aria-label="上一首"
                    disabled={!hasQueue}
                    onClick={() => void playPrev()}
                >
                    <Icon name="prev" size={18}/>
                </button>

                <button
                    className="control-button control-button--play"
                    type="button"
                    title={playState === 'loading' ? '加载中…' : isPlaying ? '暂停' : '播放'}
                    aria-label={playState === 'loading' ? '加载中' : isPlaying ? '暂停' : '播放'}
                    disabled={playState === 'loading'}
                    onClick={() => void togglePlay()}
                >
                    <Icon name={isPlaying ? 'pause-fill' : 'play-fill'} size={20}/>
                </button>

                <button
                    className="control-button"
                    type="button"
                    title="下一首"
                    aria-label="下一首"
                    disabled={!hasQueue}
                    onClick={() => void playNext()}
                >
                    <Icon name="next" size={18}/>
                </button>

                <span className="control-divider" aria-hidden="true"/>

                <QualityPanel/>

                <button
                    className="control-button"
                    type="button"
                    title={modeTitle}
                    aria-label={`播放模式：${modeTitle}`}
                    onClick={toggleMode}
                >
                    <Icon name={modeIcon}/>
                </button>

                {/* 桌面歌词窗开关 */}
                <button
                    className={`control-button${lyricShown ? ' is-active' : ''}`}
                    type="button"
                    title={lyricShown ? '关闭桌面歌词' : '桌面歌词'}
                    aria-label={lyricShown ? '关闭桌面歌词' : '桌面歌词'}
                    onClick={toggleDesktopLyric}
                >
                    <Icon name="captions" size={16}/>
                </button>

                <Popover
                    open={volumeOpen}
                    onOpenChange={setVolumeOpen}
                    side="top"
                    autoFocus={false}
                    arrow={false}
                    anchorRef={volumeAnchorRef}
                    className="control-volume-popover"
                    anchor={
                        <button
                            ref={volumeAnchorRef}
                            className="control-button"
                            type="button"
                            title={`${volume > 0 ? '静音' : '恢复音量'}（当前音量 ${volumePct}%）`}
                            aria-label={volume > 0 ? '静音' : '恢复音量'}
                            aria-haspopup="true"
                            aria-expanded={volumeOpen}
                            onClick={() => toggleMute()}
                            onMouseEnter={scheduleVolumeOpen}
                            onMouseLeave={handleVolumeLeave}
                        >
                            <span className="control-volume-icons">
                                <Icon name="volume-up-fill" className={volume > 0.5 ? undefined : 'is-hidden'} />
                                <Icon name="volume-down-fill" className={volume > 0 && volume <= 0.5 ? undefined : 'is-hidden'} />
                                <Icon name="volume-mute-fill" className={volume > 0 ? 'is-hidden' : undefined} />
                            </span>
                        </button>
                    }
                >
                    <div
                        ref={bindVolumePanelWheel}
                        className="control-volume"
                        onMouseEnter={handleVolumeEnter}
                        onMouseLeave={handleVolumeLeave}
                        onPointerDown={holdVolume}
                        onPointerUp={releaseVolume}
                    >
                        <Slider
                            value={volumePct}
                            min={0}
                            max={100}
                            step={1}
                            ariaLabel="音量"
                            onChange={(v) => setVolume(v / 100)}
                        />
                        <span className="control-volume-percent">{volumePct}%</span>
                    </div>
                </Popover>

                <span className="control-divider" aria-hidden="true"/>

                {/* 播放队列浮层 */}
                <QueuePanel/>
            </div>
        </div>
    )
}
