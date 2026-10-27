import { invoke } from './ipc'
import { ok, fail } from '@shared/result'


export const pluginList = (): Promise<PluginInfo[]> => invoke<PluginInfo[]>('plugin:list')

/** 插件根目录的绝对路径 */
export const pluginDir = (): Promise<string> => invoke<string>('plugin:dir')

export const pluginContributions = (): Promise<{
    commands: unknown[]
    menus: unknown[]
    views: unknown[]
}> => invoke('plugin:contributions')

export const pluginCommandMap = (): Promise<Record<string, string[]>> =>
    invoke<Record<string, string[]>>('plugin:commandMap')

export const setPluginEnabled = (pluginId: string, enabled: boolean): Promise<void> =>
    invoke<void>('plugin:setEnabled', pluginId, enabled)

export const uninstallPlugin = (pluginId: string,): Promise<{ success: boolean; error?: string }> =>
    invoke('plugin:uninstall', pluginId)

export const setPluginCommandEnabled = (
    pluginId: string,
    command: string,
    enabled: boolean,
): Promise<void> => invoke<void>('plugin:setCommandEnabled', pluginId, command, enabled)

export const setPluginProviderEnabled = (
    providerPluginId: string,
    targetPluginId: string,
    command: string,
    enabled: boolean,
): Promise<void> =>
    invoke<void>('plugin:setProviderEnabled', providerPluginId, targetPluginId, command, enabled)

/** 激活声明 onStartup/* 的启用插件 */
export const activateStartupPlugins = (): Promise<void> =>
    invoke<void>('plugin:activateStartupPlugins')

/** 视图消息（渲染端 → 主进程）；kind=request 时主进程会回填结果 */
export type PluginViewInbound =
    | { kind: 'send'; action: string; payload?: unknown }
    | { kind: 'request'; id: string; action: string; payload?: unknown }

/** 主进程对视图 request 的回执 */
export interface PluginViewInboundReply {
    id: string
    ok: boolean
    data?: unknown
    error?: string
}

export const sendPluginViewMessage = (
    pluginId: string,
    viewId: string,
    msg: PluginViewInbound,
): Promise<PluginViewInboundReply | null> =>
    invoke<PluginViewInboundReply | null>('plugin:viewMessage', pluginId, viewId, msg)

/** 视图对「后端发起的 request」的回执（解析 sdk 里 pending 的 Promise） */
export const replyPluginViewRequest = (
    id: string,
    reply: { ok: boolean; data?: unknown; error?: string },
): Promise<void> => invoke<void>('plugin:viewReply', id, reply)

/** 宿主事件广播（@opened / @closed），转给插件的 on() 监听 */
export const notifyPluginHostEvent = (
    pluginId: string,
    action: string,
    payload: unknown,
): Promise<void> => invoke<void>('plugin:hostEvent', pluginId, action, payload)

/**
 * 执行插件命令。plugin:invoke 为主进程唯一包装点：handler 已把结果包成 Result<T>
 * （成功 ok(value) / 失败 fail(error)），executeCommand 向上 throw 的异常也在此包成 fail。
 * 本边界统一解包为 Result<T>：success:true 取 value；false 取 error。
 * 同时兼容「主进程返回裸值」的退化情形（直接 ok 包），作防御性兜底。
 * 约定：插件命令不应把 { success: true, ... } 当作业务 payload 返回（与全局 Result<T> 契约一致）。
 */
export async function pluginInvoke<T = unknown>(
    pluginId: string,
    action: string,
    ...args: unknown[]
): Promise<Result<T>> {
    const raw = await invoke('plugin:invoke', pluginId, action, ...args)
    if (raw && typeof raw === 'object' && 'success' in raw) {
        const r = raw as { success: boolean; value?: T; error?: string }
        return r.success ? ok(r.value as T) : fail(r.error ?? '插件命令执行失败')
    }
    return ok(raw as T)
}
