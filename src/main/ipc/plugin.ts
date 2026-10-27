import { ipcMain } from 'electron'
import { inspect } from 'node:util'
import type { AppContext } from '../app'
import { pluginHost } from '../plugin/host'
import type { ViewMessage, ViewReplyPayload } from '../plugin/host'
import { resolvePluginViewRequest } from '../plugin/sdk'
import { PATHS } from '../constants/paths'
import { failWithLog, formatError, ok } from '@shared/result'
import { log } from '@main/log'

/** 结构化参数 → 日志文本 */
const show = (value: unknown): string =>
    typeof value === 'string'
        ? value
        : inspect(value, { depth: 3, breakLength: 100, maxArrayLength: 10 })

/** 给「可能抛错」的通道包一层记日志后原样抛出 */
function handle(channel: string, listener: (...args: any[]) => unknown): void {
    ipcMain.handle(channel, async (...args: unknown[]) => {
        try {
            return await listener(...args)
        } catch (e) {
            log.error(`[plugin] ${channel} 失败\n${formatError(e)}`)
            throw e
        }
    })
}

export function registerPluginHandlers(ctx: AppContext): void {
    pluginHost.setMainWindow(ctx.mainWindow)

    ipcMain.handle(
        'plugin:invoke',
        async (_e, pluginId: string, action: string, ...args: unknown[]) => {
            try {
                const value = await pluginHost.executeCommand(pluginId, action, ...args)
                return ok(value as unknown)
            } catch (err) {
                return failWithLog(
                    log,
                    'plugin',
                    `${pluginId}:${action}`,
                    `args(${args.length}): ${show(args)}`,
                    err,
                )
            }
        }
    )

    // 渲染 -> 主：同步插件列表 / 贡献点 / 有效命令映射
    ipcMain.handle('plugin:list', () => pluginHost.getPlugins())

    // 渲染 -> 主：插件根目录
    ipcMain.handle('plugin:dir', () => PATHS.getPlugins())
    ipcMain.handle('plugin:contributions', () => pluginHost.getContributions())
    ipcMain.handle('plugin:commandMap', () => pluginHost.getEffectiveCommandMap())

    // 渲染 -> 主：插件管理（启停 / 卸载 / 命令与 Provider 启停）
    handle('plugin:setEnabled', (_e, pluginId: string, enabled: boolean) => {
        pluginHost.setEnabled(pluginId, enabled)
    })
    handle('plugin:uninstall', (_e, pluginId: string) =>
        pluginHost.uninstallPlugin(pluginId)
    )
    handle('plugin:setCommandEnabled', (_e, pluginId: string, command: string, enabled: boolean) =>
        pluginHost.setCommandEnabled(pluginId, command, enabled)
    )
    handle(
        'plugin:setProviderEnabled',
        (_e, providerPluginId: string, targetPluginId: string, command: string, enabled: boolean) =>
            pluginHost.setProviderEnabled(providerPluginId, targetPluginId, command, enabled)
    )

    // 渲染 -> 主：激活声明 onStartup/* 的启用插件
    handle('plugin:activateStartupPlugins', () => {
        pluginHost.activateStartupPlugins()
    })

    // 渲染 -> 主：iframe 视图消息（kind=send 调 on() 监听；kind=request 调 handle() 并回传结果）
    handle('plugin:viewMessage', (_e, pluginId: string, viewId: string, msg: ViewMessage) =>
        pluginHost.handleViewMessage(pluginId, viewId, msg)
    )

    // 渲染 -> 主：视图对「后端发起的 request」的回执（解析 sdk 里 pending 的 promise）
    handle('plugin:viewReply', (_e, id: string, reply: ViewReplyPayload) => {
        resolvePluginViewRequest(id, reply)
    })

    // 渲染 -> 主：宿主事件广播（@opened / @closed），转给插件的 on() 监听
    handle('plugin:hostEvent', (_e, pluginId: string, action: string, payload: unknown) => {
        pluginHost.notifyHostEvent(pluginId, action, payload)
    })

    // 渲染 -> 主：SDK 经渲染进程落库的结果回传（解析主进程 invokeRenderer 的 pending promise）
    handle(
        'plugin:sdk-invoke-reply',
        (_e, payload: { requestId: string; result?: unknown; error?: string }) =>
            pluginHost.resolveRendererInvoke(payload)
    )
}
