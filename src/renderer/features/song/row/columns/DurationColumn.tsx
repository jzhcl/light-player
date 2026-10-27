import { memo } from 'react'
import { formatPlayTime } from '@shared/format'
import { Column } from './Column'

/**
 * 时长列。
 * 入参是秒，格式化交给 formatPlayTime。
 */
interface DurationColumnProps {
    duration?: number
}

function DurationColumnImpl({ duration }: DurationColumnProps) {
    return (
        <Column className="song-col--duration">
            <span className="song-duration">{formatPlayTime(duration ?? 0)}</span>
        </Column>
    )
}

export const DurationColumn = memo(DurationColumnImpl)
