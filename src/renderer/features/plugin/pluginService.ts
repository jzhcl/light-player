import {
    pluginList,
    pluginContributions,
    pluginCommandMap,
    setPluginEnabled,
    uninstallPlugin,
    setPluginCommandEnabled,
    setPluginProviderEnabled,
    pluginInvoke,
    activateStartupPlugins as activateStartupPluginsIpc,
} from '@renderer/lib/plugin'
import { usePluginStore } from '@renderer/store'
import { ok, fail } from '@shared/result'
import { rlog } from '@renderer/lib/log'


/**
 * 拉取插件列表 / contributions / 有效命令映射，一次性灌入 store，返回插件个数
 */
export async function loadPlugins(): Promise<number> {
    const [list, contributions, commandMap] = await Promise.all([
        pluginList(),
        pluginContributions(),
        pluginCommandMap(),
    ])
    const store = usePluginStore.getState()
    store.setPlugins(list)
    store.setContributions(contributions)
    store.setCommandMap(commandMap)
    return list.length
}

/** 执行插件命令 */
export function executePluginCommand<T = unknown>(
    pluginId: string,
    command: string,
    ...args: unknown[]
): Promise<Result<T>> {
    return pluginInvoke<T>(pluginId, command, ...args)
}

/** 启用 / 禁用插件，成功后刷新列表。 */
export async function togglePlugin(pluginId: string, enabled: boolean): Promise<void> {
    await setPluginEnabled(pluginId, enabled)
    await loadPlugins()
}

/** 卸载插件，成功后刷新列表。 */
export async function removePlugin(pluginId: string): Promise<Result<true>> {
    const r = await uninstallPlugin(pluginId)
    if (!r?.success) {
        rlog.error(`[plugin] 卸载插件失败 ${pluginId}：${r?.error ?? '未知原因'}`)
        return fail(r?.error ?? '卸载失败')
    }
    await loadPlugins()
    rlog.info(`[plugin] 已卸载插件 ${pluginId}`)
    return ok(true)
}

/** 启用 / 禁用插件命令，成功后刷新列表。 */
export async function togglePluginCommand(
    pluginId: string,
    command: string,
    enabled: boolean,
): Promise<void> {
    await setPluginCommandEnabled(pluginId, command, enabled)
    await loadPlugins()
}

/** 启用 / 禁用 Provider，成功后刷新列表。 */
export async function togglePluginProvider(
    providerPluginId: string,
    targetPluginId: string,
    command: string,
    enabled: boolean,
): Promise<void> {
    await setPluginProviderEnabled(providerPluginId, targetPluginId, command, enabled)
    await loadPlugins()
}

/** 激活声明 onStartup/* 的启用插件（渲染端 UI 渲染完成后调用） */
export async function activateStartupPlugins(): Promise<void> {
    await activateStartupPluginsIpc()
}
