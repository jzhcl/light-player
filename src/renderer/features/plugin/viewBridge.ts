// 视图 iframe 桥：管理已挂载的 iframe 引用，并提供
// - 向 iframe 转发视图消息（lp.ui.postToView，覆盖 modal / settings 全部视图）
// - 抽取当前主题 CSS 变量 + 主题目录下 plugin/<pluginId>.css 覆盖并注入 iframe
// 渲染端无须关心插件的 file:// 路径，仅通过 viewKey 路由

import { useSettingsStore } from '@renderer/store'
import { isFileExists, readFile } from '@renderer/lib/file'

/** 视图唯一键：pluginId::viewId */
export function viewKey(pluginId: string, viewId: string): string {
    return `${pluginId}::${viewId}`
}

/** 已挂载的 iframe 引用表，供 postToViewFrame 精准转发 */
const frames = new Map<string, HTMLIFrameElement>()

export function registerViewFrame(key: string, el: HTMLIFrameElement): void {
    frames.set(key, el)
}

export function unregisterViewFrame(key: string): void {
    frames.delete(key)
}

/**
 * 由 postMessage 的 `event.source` 反查是哪个视图发来的。
 * 不信 payload 里的 pluginId/viewId。
 */
export function findViewByWindow(
    source: MessageEventSource | null,
): { pluginId: string; viewId: string } | null {
    if (!source) return null
    for (const [key, el] of frames) {
        if (el.contentWindow === source) {
            const [pluginId, viewId] = key.split('::')
            return { pluginId, viewId }
        }
    }
    return null
}

function frameOf(pluginId: string, viewId: string): HTMLIFrameElement | undefined {
    const el = frames.get(viewKey(pluginId, viewId))
    return el
}

/** 后端 → 视图：单向推送（lp.ui.send） */
export function pushToFrame(pluginId: string, viewId: string, action: string, payload: unknown): void {
    const el = frameOf(pluginId, viewId)
    el?.contentWindow?.postMessage({ type: 'lp:push', action, payload }, '*')
}

/**
 * 后端 → 视图：请求（lp.ui.request）。
 * 返回是否投递成功 —— 未挂载时调用方要立刻回执失败，而不是让插件干等超时。
 */
export function requestFrame(
    pluginId: string,
    viewId: string,
    id: string,
    action: string,
    payload: unknown,
): boolean {
    const el = frameOf(pluginId, viewId)
    el?.contentWindow?.postMessage({ type: 'lp:request', id, action, payload }, '*')
    return Boolean(el)
}

/** 宿主 → 视图：回执（视图发起的 request 的结果） */
export function replyToFrame(
    pluginId: string,
    viewId: string,
    id: string,
    ok: boolean,
    data?: unknown,
    error?: string,
): void {
    frames.get(viewKey(pluginId, viewId))?.contentWindow?.postMessage(
        { type: 'lp:reply', id, ok, data, error },
        '*',
    )
}

/**
 * 抽取当前主题下所有 --color-* CSS 变量，用于注入 iframe
 */
export function getThemeVars(): Record<string, string> {
    const vars: Record<string, string> = {}
    if (typeof window === 'undefined' || !window.getComputedStyle) return vars
    const style = window.getComputedStyle(document.documentElement)
    for (let i = 0; i < style.length; i++) {
        const name = style.item(i)
        if (name.startsWith('--color-')) {
            vars[name] = style.getPropertyValue(name).trim()
        }
    }
    return vars
}

/**
 * 读取当前主题目录下针对某插件的样式覆盖文件 `plugin/<pluginId>.css`。
 * 该文件会被注入到对应插件的 iframe 中，用于覆盖插件内部样式以贴合当前主题。
 * 内置主题（dir 为空）或文件不存在 / 读取失败时返回 null（调用方静默跳过）。
 */
export async function collectPluginStyle(pluginId: string): Promise<string | null> {
    const dir = useSettingsStore.getState().settings['theme.current']?.dir
    if (!dir) return null
    const cssPath = dir.replace(/\\/g, '/') + '/plugin/' + pluginId + '.css'
    if (!(await isFileExists(cssPath))) return null
    const res = await readFile(cssPath)
    if (!res.success) return null
    const css = (res.value ?? '').trim()
    return css ? css : null
}

/**
 * 视图挂载时下发的初始化消息。
 * 时机 = iframe 的 onLoad（文档已加载、插件脚本已执行完）。
 *
 * `data` 来自 lp.ui.showView(viewId, { data })，必须可结构化克隆。
 */
export function sendInitToFrame(
    frame: HTMLIFrameElement,
    view: { pluginId: string; viewId: string; data?: unknown },
): void {
    frame.contentWindow?.postMessage(
        {
            type: 'lp:init',
            sdk: 1,
            pluginId: view.pluginId,
            viewId: view.viewId,
            data: view.data,
        },
        '*',
    )
}

/**
 * 把当前主题注入 iframe：① --color-* 变量；② 主题目录下 plugin/<pluginId>.css 覆盖（存在才发）。
 * iframe 加载完成后调用一次，主题切换时再调一次（pluginId 缺省时只发变量，不发插件覆盖）。
 * iframe 内脚本监听 window 'message'：type === 'lp:theme' 应用变量，type === 'lp:plugin-style' 注入 <style>。
 */
export async function sendThemeToFrame(frame: HTMLIFrameElement, pluginId?: string): Promise<void> {
    frame.contentWindow?.postMessage({ type: 'lp:theme', vars: getThemeVars() }, '*')
    if (pluginId) {
        const css = await collectPluginStyle(pluginId)
        if (css) {
            frame.contentWindow?.postMessage({ type: 'lp:plugin-style', css }, '*')
        }
    }
}

/** 向所有已注册的视图 iframe 重新注入主题变量 + 插件覆盖样式（主题切换时调用） */
export function injectThemeAllFrames(): void {
    frames.forEach((el, key) => {
        const pluginId = key.split('::')[0]
        void sendThemeToFrame(el, pluginId)
    })
}
