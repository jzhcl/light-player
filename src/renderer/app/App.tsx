import { useEffect } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { useTheme } from '@renderer/hooks/useTheme'
import { useWindowWidth } from '@renderer/hooks/useWindowWidth'
import { invokeResult } from '@renderer/lib/ipc'
import { isOk } from '@shared/result'
import { usePlayOverlayStore, useSettingsStore, useRouteHistoryStore } from '@renderer/store'
import { NAVBAR_EXPAND_THRESHOLD } from '@renderer/lib/constants'
import { initMessageHandler } from '@renderer/lib/message'
import { MessageHost } from '@renderer/components/ui/MessageHost'
import { ViewHost } from '@renderer/features/plugin/ViewHost'
import { initLyricEngine } from '@renderer/features/lyrics/engine'
import { initMediaSession } from '@renderer/features/player/mediaSession'
import { useLyricSync } from '@renderer/features/desktopLyric/useLyricSync'
import { UpdateHost } from '@renderer/features/update/UpdateHost'
import { useTraySync } from '@renderer/hooks/useTraySync'
import { PlayOverlay } from '@renderer/features/player/PlayOverlay'
import { Control } from './Control'
import { Navbar } from './Navbar'
import { Titlebar } from './Titlebar'
import { setPathname } from './locationStore'

// 全应用唯一的 useLocation 消费者：收口在返回 null 的叶子组件里。
// 它自身会在路由变化时重渲染，但返回 null → 不拖累任何子树；
// 仅负责把当前 pathname 写进 locationStore，并对路由栈做一次播种。
function LocationSync() {
    const location = useLocation()
    useEffect(() => {
        setPathname(location.pathname)
        // 首次挂载播种路由栈
        if (location.pathname) {
            useRouteHistoryStore.getState().seed({
                pathname: location.pathname,
                search: location.search,
            })
        }
    }, [location.pathname, location.search])
    return null
}


export function App() {
    useTheme()
    // 订阅主进程消息推送
    useEffect(() => initMessageHandler(), [])
    // 启动歌词引擎：切歌时加载并解析，播放时同步行级索引（低频）
    useEffect(() => initLyricEngine(), [])
    // 系统媒体信息：切歌时把当前曲同步进 MediaSession metadata（Windows 任务栏媒体控件）
    useEffect(() => initMediaSession(), [])
    // 托盘：上报播放态/当前曲，并接收托盘的播放控制命令
    useTraySync()
    // 桌面歌词窗：仅在歌词窗可见时同步歌词/播放态/进度，并接收它的控制命令
    useLyricSync()

    const expanded = useSettingsStore((s) => s.settings['ui.navbarExpanded'])
    const setSetting = useSettingsStore((s) => s.setSetting)
    const motionEnabled = useSettingsStore((s) => s.settings['appearance.motion.enabled'])
    const windowWidth = useWindowWidth()
    // 播放页浮层是否打开：打开时下层界面整块熄掉（见 layout/play.css 的 data-play-overlay）
    const playOverlayVisible = usePlayOverlayStore((s) => s.visible)

    // 界面动效开关：关闭时给 <html> 加 motion-reduced，全局禁用过渡/动画
    useEffect(() => {
        document.documentElement.classList.toggle('motion-reduced', !motionEnabled)
    }, [motionEnabled])

    // 窗口背景材质（仅 Windows）：材质本身由主进程在建窗时套用，渲染侧只需在启动时
    // 读一次、给 <html> 打 data-bg-material，让 CSS 把画布背景置透明、把系统材质透出来。
    useEffect(() => {
        void (async () => {
            const r = await invokeResult<LP.MainSetting['window.backgroundMaterial']>(
                'settings:get',
                'window.backgroundMaterial',
            )
            if (!isOk(r)) return
            document.documentElement.dataset.bgMaterial = r.value !== 'none' ? 'true' : 'false'
        })()
    }, [])

    // 窗口过窄时自动收起导航栏，避免内容区被挤压到最小宽度以下
    useEffect(() => {
        if (expanded && windowWidth < NAVBAR_EXPAND_THRESHOLD) {
            setSetting('ui.navbarExpanded', false)
        }
    }, [expanded, windowWidth])

    return (
        <div className="app flex-v" data-play-overlay={playOverlayVisible ? 'open' : 'closed'}>
            <Titlebar/>

            <div className="app-body flex-h">
                <Navbar/>

                <div className="app-main flex-v">
                    <div className="content">
                        <Outlet/>
                    </div>
                    <Control/>
                </div>
            </div>

            <MessageHost/>
            <ViewHost/>
            <UpdateHost/>
            <LocationSync/>
            {/* 播放页是全屏浮层、不占路由 */}
            <PlayOverlay/>
        </div>
    )
}
