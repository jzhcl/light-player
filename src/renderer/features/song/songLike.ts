import { addSongToPlaylist, removeSongFromPlaylist, updateSong as dbUpdateSong } from '@renderer/lib/db'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { LIKED_PLAYLIST_ID } from '@renderer/lib/constants'
import { isOk } from '@shared/result'
import { cleanupSongIfUnreachable } from './songLifecycle'

/**
 * 喜欢 / 取消喜欢
 */

/** 标记喜欢：写 isLiked + 加入“我喜欢”歌单，emit SONG.LIKED */
export async function markSongLike(songId: string): Promise<Result<boolean>> {
    const r = await dbUpdateSong(songId, { isLiked: true })
    if (!isOk(r)) return r
    const add = await addSongToPlaylist(LIKED_PLAYLIST_ID, songId, 0)
    if (!isOk(add)) return add
    eventBus.emit(LP_EVENT['SONG.LIKED'], { id: songId })
    return r
}

/** 取消喜欢：写 isLiked=false + 移出“我喜欢”歌单，emit SONG.UNLIKED。 */
export async function unmarkSongLike(songId: string): Promise<Result<boolean>> {
    const r = await dbUpdateSong(songId, { isLiked: false })
    if (!isOk(r)) return r
    const del = await removeSongFromPlaylist(LIKED_PLAYLIST_ID, songId)
    if (!isOk(del)) return del
    eventBus.emit(LP_EVENT['SONG.UNLIKED'], { id: songId })
    // 取消喜欢后这首歌可能再没有任何入口（不在歌单 / 没播放记录 / 非本地）→ 顺手回收
    void cleanupSongIfUnreachable(songId)
    return r
}
