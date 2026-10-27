import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { router } from './app/router'
import './styles/global.css'
import './styles/layout.css'
import './styles/icon.css'
import { useSettingsStore, initPathSettings, ensurePathDirs } from '@renderer/store/settingsStore'
import { useUpdateStore } from '@renderer/store/updateStore'
import { initTheme } from '@renderer/hooks/useTheme'
import { createPlaylist, trimSongPlayedStats } from '@renderer/lib/db'
import { LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME } from '@renderer/lib/constants'
import { loadAllPlaylists } from '@renderer/features/playlist/playlistService'
import { loadPlugins, activateStartupPlugins } from '@renderer/features/plugin/pluginService'
import { initPluginIpc } from '@renderer/features/plugin/pluginIpc'
import { restorePlayback } from '@renderer/features/player/player'
import { initHotkeys } from '@renderer/features/hotkeys/hotkeys'
import { initDownload } from '@renderer/features/download/downloadService'
import { initLocalFileCheck } from '@renderer/lib/localFileCheck'
import { invoke, invokeResult } from '@renderer/lib/ipc'
import { isOk } from '@shared/result'
import { compareVersion } from '@shared/utils'
import { installErrorHooks, rlog } from '@renderer/lib/log'

// 全局异常兜底
installErrorHooks()

// ============================================================
// 「UI 已渲染」信号
// ============================================================
let signalUiRendered: () => void = () => {}
const uiRendered = new Promise<void>((resolve) => { signalUiRendered = resolve })

/**
 * 渲染完成信号组件。
 */
function OnRendered(): null {
    useEffect(() => { signalUiRendered() }, [])
    return null
}

/** 跑一步并记一条带该步自身耗时的日志 */
async function step<T>(
    label: string,
    fn: () => Promise<T>,
    detail?: (value: T) => string,
): Promise<T> {
    const t = performance.now()
    const value = await fn()
    const suffix = detail ? ` ${detail(value)}` : ''
    rlog.info(`[startup] ${label}${suffix} ${Math.round(performance.now() - t)}ms`)
    return value
}

/** 启动期本地态初始化：首启歌单 + 版本对齐 */
async function initStartupState() {
    const { settings, setSetting } = useSettingsStore.getState()
    const version = await invoke<string>('app:getVersion')
    const recorded = settings['application.version']

    if (!recorded) {
        rlog.info('[startup] 首次启动')
        // 第一次使用 — 创建「我喜欢」歌单
        await createPlaylist({
            id: LIKED_PLAYLIST_ID,
            pluginId: 'local',
            name: LIKED_PLAYLIST_NAME,
            description: '默认喜欢的音乐会被添加到这里',
        })
    }
    if (recorded !== version) {
        if (recorded) {
            // 只有「真的升级」才弹更新日志
            if (compareVersion(version, recorded) > 0) {
                rlog.info(`[startup] 版本变更 ${recorded} → ${version}`)
                // 刚升级过：把旧版本交给 UpdateHost，它按设置决定要不要弹本次更新日志。
                // 必须在 setSetting 覆盖之前取，之后这个值就没了。
                useUpdateStore.getState().setPreviousVersion(recorded)
            } else {
                rlog.info(`[startup] 版本回退 ${recorded} → ${version}（不弹更新日志）`)
            }
        }
        setSetting('application.version', version)
    }
}

// ============================================================
// 渲染前 / 渲染后 两段初始化
// ============================================================

/**
 * 渲染前初始化：UI 首帧要读到的状态，全部 `await` 到位再 `render()`。
 *
 * 只放轻量的 IPC / DB 往返 —— 这里的每一毫秒都会变成主窗「首次可见」之前的时间。
 */
async function initBeforeUi(): Promise<void> {
    // 首启：创建「我喜欢」歌单 + 版本对齐（含升级钩子）。
    await step('初始化本地状态', initStartupState)
    // 路径设置：逐键补空。
    await step('初始化路径设置', initPathSettings)
    // 确保三个路径目录存在（幂等，每次启动都做）。
    await step('准备程序目录', ensurePathDirs)
    // 恢复上次退出时的当前曲（只立为当前曲，不自动播放）—— 底栏首帧就要显示它。
    await step('恢复当前歌曲', restorePlayback, (song) =>
        song ? `${song.name}-${song.singer}(${song.album ?? '未知专辑'})` : '（无）',
    )
    // 下载：先订阅主进程下载事件（维护 download_records 状态），再清理上次强杀留下的半截文件。
    await step('初始化下载', initDownload)
    // 首启可能刚创建「我喜欢」歌单，随后一次性加载全部歌单到 store —— 导航栏/歌单页首帧要读。
    await step('加载歌单', loadAllPlaylists, (n) => `${n} 个（不含「我喜欢」）`)
    // 插件：先注册主进程推送监听（sdk-invoke/console/panel），再拉取插件列表到 store。
    initPluginIpc()
    rlog.info('[startup] 插件 IPC 已注册')
    await step('加载插件列表', loadPlugins, (n) => `${n} 个`)
}

/**
 * 渲染后初始化：不参与首帧的启动任务，全部 fire-and-forget（失败不拦启动）。
 */
function initAfterUi(): void {
    // 快捷键引擎：应用内监听 + 全局触发监听 + 启动恢复全局注册。
    initHotkeys()
    rlog.debug('[startup] 后台：快捷键引擎已就绪')
    // 启动清理超额播放记录（把历史播放记录控制在上限内）。
    void trimSongPlayedStats()
    rlog.debug('[startup] 后台：播放记录裁剪已派发')
    // 激活声明 onStartup/* 的启用插件。
    void activateStartupPlugins()
    rlog.debug('[startup] 后台：启动插件激活已派发')
    // 本地文件检查：启动时扫一次（节流档位取设置）。
    void initLocalFileCheck(useSettingsStore.getState().settings['localFile.checkInterval'])
    rlog.debug('[startup] 后台：本地文件检查已派发')
    // 自动检查更新
    void startUpdateCheck()
}

/**
 * 启动后检查一次更新。
 * 无新版本时什么都不发生；有新版本由 UpdateHost 收到事件后按设置决定「自动下载」还是「只提示」。
 */
async function startUpdateCheck(): Promise<void> {
    // 开发模式没有 app-update.yml，检查必定失败 —— 不在控制台制造噪音
    if (window.env.isDev) return
    const r = await invokeResult<null>('update:check')
    if (!isOk(r)) rlog.warn(`[update] 启动检查失败：${r.error}`)
}

/**
 * 启动：主题（同步）→ 渲染前初始化 → 渲染 → 等 UI 就绪 → 渲染后初始化。
 */
async function boot(): Promise<void> {
    const t0 = performance.now()
    rlog.info(`[startup] 主窗口启动（${import.meta.env.PROD ? 'prod' : 'dev'}）`)

    // 首屏前同步应用当前主题（内置浅/深 或 自定义），避免无主题 CSS 的闪白。
    // 它必须在 `render()` 之前、且必须能同步完成（依赖 settingsStore 的同步水合）。
    initTheme()
    rlog.info('[startup] 主题已应用')

    // 影响行为的设置先落一条
    const s = useSettingsStore.getState().settings
    rlog.info(
        '[startup] 关键设置\n' +
        `  优先播放音质 ${s['player.preferredQuality']} · 下载优先高音质 ${s['download.preferHigherQuality'] ? '开' : '关'}\n` +
        `  播放失败自动切换 ${s['player.autoSkipOnError'] ? '开' : '关'} · ` +
        `全局快捷键 ${s['hotkey.global.enable'] ? '开' : '关'} · ` +
        `本地文件检查 ${s['localFile.checkInterval']}`,
    )

    await initBeforeUi()

    createRoot(document.getElementById('root')!).render(
        <StrictMode>
            <RouterProvider router={router}/>
            <OnRendered/>
        </StrictMode>,
    )

    await uiRendered
    rlog.info(`[startup] UI 已就绪 ${Math.round(performance.now() - t0)}ms`)

    initAfterUi()
}

void boot()
