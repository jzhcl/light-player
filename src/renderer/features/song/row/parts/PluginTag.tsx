import { memo } from 'react'
import { usePluginStore, useSettingsStore } from '@renderer/store'

/**
 * 插件来源标签。
 *
 *   1. `pluginId === 'local'` → 「本地」
 *   2. 能在插件表查到 → `plugin.label || plugin.name`（label 是插件自报的短标识，优先）
 *   3. 查不到（插件已卸载 / DB 无记录）→ 原始 `pluginId`
 *
 * 与 `LocalBadge` 的区别：那个表达「离线可播放」（`downloadQualities` 非空，图标），
 * 这个表达「这首歌从哪来」（文字标签），两者判据不同、可同时出现。
 */
interface PluginTagProps {
    pluginId: string
}

function PluginTagImpl({ pluginId }: PluginTagProps) {
    const enabled = useSettingsStore((s) => s.settings['playlist.showPluginTag'])
    const label = usePluginStore((s) => {
        if (pluginId === 'local') return '本地'
        const plugin = s.plugins.find((p) => p.id === pluginId)
        return plugin?.label || plugin?.name || pluginId
    })
    if (!enabled) return null
    return <span className="song-tag song-tag--plugin">{label}</span>
}

export const PluginTag = memo(PluginTagImpl)