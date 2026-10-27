import { memo } from 'react'
import { Icon } from '@renderer/components/Icon'

/**
 * 「本地可播放」徽章。
 *
 * 判定依据是 `downloadQualities` 非空 —— 本机导入的歌曲入库时同样会写入该项
 * （`pluginId === 'local'` 且 `downloadQualities = [{ path: 文件路径 }]`），
 * 因此这一个字段就能同时覆盖「本机导入」与「插件歌曲已下载」两种情况。
 *
 * 不符合条件时返回 null。
 */
export interface LocalBadgeProps {
    downloadQualities?: { path: string }[]
}

function LocalBadgeImpl({ downloadQualities }: LocalBadgeProps) {
    if (!downloadQualities || downloadQualities.length === 0) return null
    return (
        <span className="song-badge--local" title="本地可播放">
            <Icon name="local-badge" size={12}/>
        </span>
    )
}

export const LocalBadge = memo(LocalBadgeImpl)
