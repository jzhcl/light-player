import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouteNavigation } from '@renderer/hooks/useRouteNavigation'
import { useWindowControls } from '@renderer/hooks/useWindowControls'
import { Icon } from '@renderer/components/Icon'
import { SearchBox } from '@renderer/app/components/SearchBox'
import { usePlayerStore, useIsPlaying, useSettingsStore } from '@renderer/store'
import logoIcon from '@assets/images/logo-icon-round.png'

// 路由前进/后退按钮
function HistoryButtons() {
    const { canGoBack, canGoForward, back, forward } = useRouteNavigation()
    return (
        <div className="titlebar-history h-center">
            <button
                className={`icon-button no-draggable center${canGoBack ? '' : ' disabled'}`}
                title="后退"
                aria-label="后退"
                disabled={!canGoBack}
                onClick={back}
            >
                <Icon name="chevron-left"/>
            </button>
            <button
                className={`icon-button no-draggable center${canGoForward ? '' : ' disabled'}`}
                title="前进"
                aria-label="前进"
                disabled={!canGoForward}
                onClick={forward}
            >
                <Icon name="chevron-right"/>
            </button>
        </div>
    )
}

// 标题栏：左=品牌 + 路由前进后退，中=搜索区（与歌曲状态共占一格），右=窗口控制
export function Titlebar() {
    const { minimize, close } = useWindowControls()
    const showSongStatus = useSettingsStore((s) => s.settings['appearance.titlebar.showSongStatus'])
    const currentSong = usePlayerStore((s) => s.currentSong)
    const isPlaying = useIsPlaying()

    // 当前歌曲状态文本：无歌时给一句占位，不空行
    const songStatusText = currentSong
        ? currentSong.singer
            ? `${currentSong.name} - ${currentSong.singer}`
            : currentSong.name
        : '未播放歌曲'

    // ---- 搜索区悬停唤起----
    // 设置项开启时，搜索框空闲态把位置让给歌曲状态；指针悬停搜索区 200ms 后把搜索框唤回，
    // 指针离开即收回（聚焦 / 有文字时搜索框自己撑着，不靠悬停）。
    const [searchHovered, setSearchHovered] = useState(false)
    const hoverTimerRef = useRef<number | null>(null)
    useEffect(
        () => () => {
            if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
        },
        [],
    )
    const handleSearchAreaEnter = useCallback(() => {
        if (!showSongStatus) return
        if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = window.setTimeout(() => setSearchHovered(true), 200)
    }, [showSongStatus])
    const handleSearchAreaLeave = useCallback(() => {
        if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
        hoverTimerRef.current = null
        setSearchHovered(false)
    }, [])

    // 搜索框空闲态（由 SearchBox 上报）：空闲且未被悬停唤起 → 歌曲状态可见，两层同步淡入淡出
    const [searchIdle, setSearchIdle] = useState(true)
    const handleIdleChange = useCallback((idle: boolean) => setSearchIdle(idle), [])
    const statusVisible = showSongStatus && searchIdle && !searchHovered

    return (
        <div className="titlebar draggable h-center">
            <div className="titlebar-left h-center">
                <img className="titlebar-logo" src={logoIcon} alt="LightPlayer"/>
                <HistoryButtons />
            </div>

            <div
                className="titlebar-center h-center"
                onMouseEnter={handleSearchAreaEnter}
                onMouseLeave={handleSearchAreaLeave}
            >
                {/* 歌曲状态与搜索框共占中央同一格：搜索框淡出时它淡入。
                    绝对定位不参与宽度计算 —— 中央槽宽度恒由搜索框决定。 */}
                <span
                    className={
                        'titlebar-songstatus' +
                        (statusVisible ? '' : ' is-concealed') +
                        (isPlaying ? ' is-playing' : '')
                    }
                    title={songStatusText}
                >
                    {/* 音柱条：播放时跳动、未播放时隐藏。柱槽常驻 ——
                        隐去时文字不跳位；柱色走主题主色（.wave-bar 通用件）。 */}
                    <span className="titlebar-songstatus-spectrum wave" aria-hidden="true">
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                    </span>
                    <span className="titlebar-songstatus-text ellipsis">{songStatusText}</span>
                </span>
                <SearchBox concealed={showSongStatus && !searchHovered} onIdleChange={handleIdleChange} />
            </div>

            <div className="titlebar-right h-center">
                <button
                    className="icon-button no-draggable center"
                    title="最小化"
                    aria-label="最小化"
                    onClick={minimize}
                >
                    <Icon name="dash"/>
                </button>
                <button
                    className="icon-button icon-button--danger no-draggable center"
                    title="关闭"
                    aria-label="关闭窗口"
                    onClick={close}
                >
                    <Icon name="x"/>
                </button>
            </div>
        </div>
    )
}
