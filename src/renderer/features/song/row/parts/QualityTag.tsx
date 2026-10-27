import { memo } from 'react'
import { useSettingsStore } from '@renderer/store'
import { QUALITY_BY_BITRATE } from '@renderer/lib/constants'

/**
 * 音质标签，显示歌曲的最高支持档；
 * 没有音质信息、或最高档就只有 Standard 时返回 null。
 */
interface QualityTagProps {
    quality?: { type: Quality }[]
}

function QualityTagImpl({ quality }: QualityTagProps) {
    const enabled = useSettingsStore((s) => s.settings['playlist.showQualityTag'])
    const top = quality
        ? QUALITY_BY_BITRATE.find((t) => t !== 'Standard' && quality.some((q) => q.type === t))
        : undefined
    if (!enabled || !top) return null
    return <span className="song-tag song-tag--quality">{top}</span>
}

export const QualityTag = memo(QualityTagImpl)
