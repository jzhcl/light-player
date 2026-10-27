import { useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { ModalShell } from '@renderer/components/ui/Modal'
import { usePluginStore, useSettingsStore } from '@renderer/store'
import {
    registerViewFrame,
    unregisterViewFrame,
    sendInitToFrame,
    sendThemeToFrame,
    injectThemeAllFrames,
} from './viewBridge'
import type { ActiveView } from '@renderer/store/pluginStore'


/** 视图缺省尺寸（与 contributions.views[].size 缺省值一致） */
const DEFAULT_VIEW_WIDTH = 480
const DEFAULT_VIEW_HEIGHT = 360

/**
 * 解析插件声明的视图尺寸。
 * manifest 来自插件作者，`size` 未经 loader 校验 → 这里必须自己挡掉非正数 / NaN / 非数字，
 * 否则会直接写进 inline style 产出无效尺寸（iframe 塌成 0）。
 * 视口上限不在这里做：交给 CSS max-width/max-height（inline 尺寸与 max-* 是「约束优先」，
 * 窗口 resize 自动跟随，无需重算）。
 */
function resolveViewSize(size?: { width: number; height: number }) {
    const valid = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
    if (!valid(size?.width) || !valid(size?.height)) {
        return { width: DEFAULT_VIEW_WIDTH, height: DEFAULT_VIEW_HEIGHT }
    }
    return { width: Math.round(size!.width), height: Math.round(size!.height) }
}


function ViewFrame({ view }: { view: ActiveView }) {
    const ref = useRef<HTMLIFrameElement | null>(null)
    const key = `${view.pluginId}::${view.viewId}`

    const setFrameRef = useCallback(
        (el: HTMLIFrameElement | null) => {
            ref.current = el
            if (el) {
                registerViewFrame(key, el)
                // 插入时先注入一次；onLoad 再补一次，覆盖「ref 早于文档加载完成」
                void sendThemeToFrame(el, view.pluginId)
            } else {
                unregisterViewFrame(key)
            }
        },
        [key, view.pluginId],
    )

    /**
     * iframe 文档加载完成 = 视图「已挂载」。此时脚本已执行完，可以安全收 postMessage：
     *   ① lp:init  带 showView 的初始载荷
     *   ② lp:theme 当前主题变量 + 主题目录下的插件样式覆盖
     */
    const onIframeLoad = () => {
        const el = ref.current
        if (!el) return
        sendInitToFrame(el, view)
        void sendThemeToFrame(el, view.pluginId)
    }

    const close = () => usePluginStore.getState().closeView(view.pluginId, view.viewId)

    const size = resolveViewSize(view.size)
    // escClose 是 SDK 侧单一开关：同时管 ESC 与点蒙层（保持既有契约）
    const closable = view.escClose !== false

    return (
        <ModalShell
            open
            onOpenChange={(o) => {
                if (!o) close()
            }}
            className="modal--plugin-view"
            contentStyle={size}
            contentLabel={view.title ?? view.viewId}
            maskClosable={closable}
            escClosable={closable}
            // 插件层固定在最底：程序内对话框的 depth 从 1 起，永远压在插件视图之上
            depth={0}
        >
            <iframe
                ref={setFrameRef}
                className="plugin-view-frame"
                src={view.entryUrl}
                sandbox="allow-scripts"
                onLoad={onIframeLoad}
            />
        </ModalShell>
    )
}


/**
 * 插件视图宿主：渲染 plugin 层的当前唯一视图。
 * - 焦点陷阱 / ESC / 点蒙层关闭 / 滚动锁 / 无障碍 全部由 ModalShell 提供。
 * - 视图尺寸由插件 contributions.views[].size 定义（缺省 480×360），
 *   外壳盒尺寸 = 声明尺寸（无边框、无内边距），超视口由 CSS max-* 压缩。
 * - iframe 内部滚动归插件自己（宿主不接管），尺寸被压缩时插件页面自行适配。
 */
export function ViewHost() {
    const activeView = usePluginStore((s) => s.activeView)
    const theme = useSettingsStore((s) => s.settings['theme.current'])

    // 主题切换：重注入所有视图 iframe 的主题变量 + 插件覆盖样式
    useEffect(() => {
        injectThemeAllFrames()
    }, [theme])

    if (!activeView || activeView.container !== 'modal') return null

    return createPortal(
        <ViewFrame key={`${activeView.pluginId}::${activeView.viewId}`} view={activeView} />,
        document.body,
    )
}
