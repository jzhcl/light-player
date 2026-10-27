import type { ReactNode } from 'react'
import { Column } from './Column'

/**
 * 控件列：`.song-col--actions` 外框 + `.song-actions` 横向排版。
 */
interface ActionsColumnProps {
    children: ReactNode
}

export function ActionsColumn({ children }: ActionsColumnProps) {
    return (
        <Column className="song-col--actions">
            <span className="song-actions">{children}</span>
        </Column>
    )
}
