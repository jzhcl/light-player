import { memo } from 'react'
import { Cover, type PicLike } from '@renderer/components/ui/Cover'
import { Column } from './Column'

/**
 * 封面列。
 *
 * 地址解析、回退与无图占位都在 `Cover` 里；本列只负责「占栅格一格」、给出行内封面的
 * 几何（`.song-cover`），并对列表开启懒加载。
 */
export interface PicColumnProps {
    pic?: PicLike
}

function PicColumnImpl({ pic }: PicColumnProps) {
    return (
        <Column className="song-col--pic">
            <Cover pic={pic} className="song-cover" lazy/>
        </Column>
    )
}

export const PicColumn = memo(PicColumnImpl)
