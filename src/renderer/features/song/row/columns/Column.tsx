import type { ComponentProps } from 'react'

/**
 * 歌曲列表列容器：统一携带 `.song-col`，使用处只补自己的修饰类。
 */
interface ColumnProps extends ComponentProps<'span'> {
    className?: string
}

export function Column({ className, ...rest }: ColumnProps) {
    return <span className={className ? `song-col ${className}` : 'song-col'} {...rest}/>
}
