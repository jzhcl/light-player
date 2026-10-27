import { memo } from 'react'
import { Column } from './Column'

/**
 * 专辑列：无专辑时以 `-` 占位
 */
interface AlbumColumnProps {
    album?: string
}

function AlbumColumnImpl({ album }: AlbumColumnProps) {
    return (
        <Column className="song-col--album">
            <span className={`song-album ellipsis${album ? '' : ' song-album--empty'}`}>
                {album || '-'}
            </span>
        </Column>
    )
}

export const AlbumColumn = memo(AlbumColumnImpl)
