import { useEffect } from 'react'
import { usePluginStore } from '@renderer/store'
import { loadPlugins, executePluginCommand } from './pluginService'


/**
 * 组件内获取插件列表，并确保首次挂载时已加载
 */
export function usePlugins(): PluginInfo[] {
    const plugins = usePluginStore((s) => s.plugins)
    useEffect(() => {
        if (usePluginStore.getState().plugins.length === 0) void loadPlugins()
    }, [])
    return plugins
}

export { executePluginCommand }
