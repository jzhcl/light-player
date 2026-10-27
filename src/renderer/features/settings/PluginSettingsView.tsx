import { useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { usePluginStore, useSettingsStore } from '@renderer/store'
import { loadPlugins } from '@renderer/features/plugin/pluginService'
import {
    registerViewFrame,
    unregisterViewFrame,
    sendInitToFrame,
    sendThemeToFrame,
    viewKey,
} from '@renderer/features/plugin/viewBridge'


/**
 * 插件设置页（路由 /settings/plugin-settings/:id?view=<viewId>）。
 *
 * - 渲染由 ?view= 指定的 settings 视图；缺省渲染第一个（manifest 顺序）。
 * - iframe 注册进共享 frames Map，使 lp.ui.postToView / 主题注入同时覆盖 modal 与 settings 视图。
 * - iframe 回传消息（lp:view-message / lp:open-view）已由 pluginIpc 集中监听，本页不再单独监听。
 */
export function PluginSettingsView() {
    const { id } = useParams<{ id: string }>()
    // 设置页每插件只允许 1 个（loader 校验），?view= 仅用于 showView 定位
    const [searchParams] = useSearchParams()
    const plugin = usePluginStore((s) => s.plugins.find((p) => p.id === id))
    const theme = useSettingsStore((s) => s.settings['theme.current'])
    const frameRef = useRef<HTMLIFrameElement>(null)

    // 插件列表未加载时补拉一次
    useEffect(() => {
        if (!plugin) void loadPlugins()
    }, [plugin])

    const settingsViews = ((plugin?.views ?? []) as PluginViewContribution[]).filter(
        (v) => v.container === 'settings',
    )
    const viewId = searchParams.get('view')
    const target =
        (viewId ? settingsViews.find((v) => v.id === viewId) : undefined) ?? settingsViews[0]
    const frameKey = id && target ? viewKey(id, target.id) : undefined

    // 注册/注销 iframe 到共享 frames Map（供 postToViewFrame / injectThemeAllFrames 覆盖）
    useEffect(() => {
        const el = frameRef.current
        if (el && frameKey) {
            registerViewFrame(frameKey, el)
            void sendThemeToFrame(el, id)
        }
        return () => {
            if (frameKey) unregisterViewFrame(frameKey)
        }
    }, [frameKey, id])

    // 主题切换：重注入设置 iframe 的主题变量 + 插件覆盖样式
    useEffect(() => {
        if (frameRef.current) void sendThemeToFrame(frameRef.current, id)
    }, [theme, id])

    if (!plugin) {
        return <div className="settings-loading">加载中…</div>
    }

    // 没有可渲染的设置视图：正常进不来（导航项只在有 settings 视图时出现），保底给个提示
    if (!target) {
        return (
            <div className="plugin-settings plugin-settings--empty">
                <span className="plugin-empty-text">该插件未提供设置页</span>
            </div>
        )
    }

    // 整个容器交给插件页面：不再套 settings-group 的标题/分组语义，iframe 自己负责排版
    return (
        <div className="plugin-settings">
            <iframe
                ref={frameRef}
                key={target.id}
                className="plugin-settings-frame"
                src={target.entryUrl}
                sandbox="allow-scripts"
                onLoad={() => {
                    const el = frameRef.current
                    if (!el) return
                    // settings 视图是路由页，没有 showView 的 data；仍发一版 init
                    // 让视图统一走同一个初始化入口（拿 pluginId / viewId / sdk 版本）
                    sendInitToFrame(el, { pluginId: id ?? '', viewId: target.id })
                    void sendThemeToFrame(el, id)
                }}
            />
        </div>
    )
}
