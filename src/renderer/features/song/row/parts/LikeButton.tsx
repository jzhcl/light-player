import { memo } from 'react'
import { Icon } from '@renderer/components/Icon'

/** 喜欢按钮 */
export interface LikeButtonProps<T> {
    /** 该行数据，原样回传给 onToggle */
    row: T
    isLiked: boolean
    onToggle: (row: T) => void
}

function LikeButtonImpl<T>({ row, isLiked, onToggle }: LikeButtonProps<T>) {
    return (
        <button
            className={`song-action song-action--like${isLiked ? ' is-active' : ''}`}
            type="button"
            title={isLiked ? '取消喜欢' : '喜欢'}
            onClick={(e) => {
                e.stopPropagation()
                onToggle(row)
            }}
        >
            <Icon name={isLiked ? 'heart-fill' : 'heart'} size={15}/>
        </button>
    )
}

export const LikeButton = memo(LikeButtonImpl) as typeof LikeButtonImpl
