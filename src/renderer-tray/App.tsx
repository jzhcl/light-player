import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { TOPIC } from '@shared/topic'
import { TrayIcon } from './Icon'

const DEFAULT_STATE: TrayMenuState = {
    isPlaying: false,
    songTitle: '',
    singer: '',
    isLiked: false,
    playMode: 'loop',
    volume: 0.7,
    lyricVisible: false,
}

const MODE_TITLE: Record<PlayMode, string> = {
    loop: '列表循环',
    single: '单曲循环',
    random: '随机播放',
}

const WHEEL_STEP = 0.1

function clampVolume(value: number): number {
    return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
}

export function App() {
    const [state, setState] = useState<TrayMenuState>(DEFAULT_STATE)
    const [volume, setVolume] = useState(DEFAULT_STATE.volume)
    const draggingRef = useRef(false)
    const wheelEndRef = useRef<number | null>(null)
    const volumeRowRef = useRef<HTMLDivElement | null>(null)

    // 主窗同款通信：状态由主进程按 topic 推来；挂载时再主动拉一次快照，
    // 因为推送可能早于本页加载完成。
    useEffect(() => {
        let alive = true
        void window.api
            .invoke<TrayMenuState>('trayMenuWindow:getState')
            .then((next) => {
                if (alive && next) setState(next)
            })
            .catch(() => {})

        const off = window.api.subscribe(TOPIC.TRAY_MENU, (channel, ...args) => {
            if (channel !== 'trayMenuStateChanged') return
            const next = args[0] as TrayMenuState | undefined
            if (next && typeof next === 'object') setState(next)
        })
        return () => {
            alive = false
            off()
        }
    }, [])

    // 拖拽音量时以本地值为准，避免状态回传落后造成滑块回跳。
    // layout effect 保证外部状态与文案在同一帧内落到 DOM，不出现「歌名已换、音量还是上一首」的中间态。
    useLayoutEffect(() => {
        if (!draggingRef.current) setVolume(state.volume)
    }, [state.volume])

    /** 播放控制走主窗 topic 命令 */
    const command = (channel: string, ...args: unknown[]): void => {
        window.api.publish(TOPIC.MAIN, channel, ...args)
    }

    // 静音要能还原到静音前的音量
    const lastVolumeRef = useRef(volume > 0 ? volume : 0.6)
    useEffect(() => {
        if (volume > 0) lastVolumeRef.current = volume
    }, [volume])

    const toggleMute = (): void => {
        const next = volume > 0 ? 0 : lastVolumeRef.current
        setVolume(next)
        command('control:setVolume', next)
    }

    // 音量行滚轮：每格 10%，与拖动一样在短窗口内忽略外部回传，避免滑块回跳
    useEffect(() => {
        const el = volumeRowRef.current
        if (!el) return

        const onWheel = (event: WheelEvent): void => {
            event.preventDefault()
            if (event.deltaY === 0) return

            const next = clampVolume(volume + (event.deltaY > 0 ? -WHEEL_STEP : WHEEL_STEP))
            if (next === volume) return

            draggingRef.current = true
            if (wheelEndRef.current !== null) window.clearTimeout(wheelEndRef.current)
            wheelEndRef.current = window.setTimeout(() => {
                draggingRef.current = false
                wheelEndRef.current = null
            }, 250)

            setVolume(next)
            command('control:setVolume', next)
        }

        el.addEventListener('wheel', onWheel, { passive: false })
        return () => el.removeEventListener('wheel', onWheel)
    }, [volume])

    useEffect(() => () => {
        if (wheelEndRef.current !== null) window.clearTimeout(wheelEndRef.current)
    }, [])

    const hasSong = state.songTitle !== ''
    const volumePct = Math.round(volume * 100)
    const likeTitle = state.isLiked ? '取消喜欢' : '喜欢'

    return (
        <div
            className="app"
            onContextMenu={(e) => e.preventDefault()}
            // 卡片外那圈是留给阴影的透明边（窗口比卡片大），点它按「点别处」处理
            onPointerDown={(e) => {
                if (e.target === e.currentTarget) void window.api.invoke('trayMenuWindow:hide')
            }}
        >
            <div className="menu">
                <div className="panel">
                    <div className="song">
                        <span
                            className={`song__title${hasSong ? '' : ' song__title--empty'}`}
                            title={state.songTitle || undefined}
                        >
                            {state.songTitle || '暂无播放'}
                        </span>
                        <span className="song__artist" title={state.singer || undefined}>
                            {state.singer || (hasSong ? '未知歌手' : '')}
                        </span>
                    </div>

                    <div className="controls">
                        <button
                            className={`ctl ctl--aux${state.isLiked ? ' is-active' : ''}`}
                            type="button"
                            title={likeTitle}
                            aria-label={likeTitle}
                            aria-pressed={state.isLiked}
                            disabled={!hasSong}
                            onClick={() => command('control:toggleLike')}
                        >
                            <TrayIcon name={state.isLiked ? 'heart-fill' : 'heart'} size={15}/>
                        </button>
                        <button
                            className="ctl"
                            type="button"
                            title="上一首"
                            aria-label="上一首"
                            onClick={() => command('control:previous')}
                        >
                            <TrayIcon name="prev" size={16}/>
                        </button>
                        <button
                            className="ctl ctl--play"
                            type="button"
                            title={state.isPlaying ? '暂停' : '播放'}
                            aria-label={state.isPlaying ? '暂停' : '播放'}
                            onClick={() => command('control:playPause')}
                        >
                            <TrayIcon name={state.isPlaying ? 'pause-fill' : 'play-fill'} size={16}/>
                        </button>
                        <button
                            className="ctl"
                            type="button"
                            title="下一首"
                            aria-label="下一首"
                            onClick={() => command('control:next')}
                        >
                            <TrayIcon name="next" size={16}/>
                        </button>
                        <button
                            className="ctl ctl--aux"
                            type="button"
                            title={MODE_TITLE[state.playMode]}
                            aria-label={MODE_TITLE[state.playMode]}
                            onClick={() => command('control:cyclePlayMode')}
                        >
                            <TrayIcon name={state.playMode} size={15}/>
                        </button>
                    </div>

                    <div className="volume" ref={volumeRowRef}>
                        <button
                            className="volume__icon"
                            type="button"
                            title={volume > 0 ? '静音' : '取消静音'}
                            aria-label={volume > 0 ? '静音' : '取消静音'}
                            aria-pressed={volume <= 0}
                            onClick={toggleMute}
                        >
                            <TrayIcon
                                name={volume <= 0 ? 'volume-mute-fill' : volume <= 0.5 ? 'volume-down-fill' : 'volume-up-fill'}
                                size={15}
                            />
                        </button>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={volume}
                            title={`音量 ${volumePct}%`}
                            aria-label="音量"
                            style={{ '--pct': `${volumePct}%` } as CSSProperties}
                            onPointerDown={() => {
                                draggingRef.current = true
                            }}
                            onPointerUp={() => {
                                draggingRef.current = false
                            }}
                            onPointerCancel={() => {
                                draggingRef.current = false
                            }}
                            onBlur={() => {
                                draggingRef.current = false
                            }}
                            onChange={(e) => {
                                const next = Number(e.target.value)
                                setVolume(next)
                                command('control:setVolume', next)
                            }}
                        />
                        <span className="volume__value">{volumePct}%</span>
                    </div>
                </div>

                <div className="items">
                    <button
                        className="item"
                        type="button"
                        onClick={() => {
                            command('control:toggleDesktopLyricWindow')
                            // 开关歌词窗看得见结果，菜单该收起了
                            void window.api.invoke('trayMenuWindow:hide')
                        }}
                    >
                        <TrayIcon name="captions" size={16}/>
                        <span>{state.lyricVisible ? '关闭桌面歌词' : '显示桌面歌词'}</span>
                    </button>

                    <button
                        className="item item--danger"
                        type="button"
                        onClick={() => {
                            void window.api.invoke('app:quit')
                        }}
                    >
                        <TrayIcon name="power" size={16}/>
                        <span>退出</span>
                    </button>
                </div>
            </div>
        </div>
    )
}
