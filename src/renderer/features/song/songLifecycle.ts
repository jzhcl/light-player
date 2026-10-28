import {
    deleteDownloadRecordsBySongId,
    deletePlaylistSongsBySongId,
    deleteSong as dbDeleteSong,
    deleteSongLyric,
    deleteSongPlayedStats,
    getPlaylistIdsBySongId,
    getSongById,
    getSongPlayedStatsBySongId,
    getUnfinishedDownloadRecordBySongId,
} from '@renderer/lib/db'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { usePlayerStore } from '@renderer/store'
import { isOk } from '@shared/result'

/**
 * 歌曲生命周期：删除与「不可达回收」。
 *
 * 一首歌被删时要连带清掉的东西都收在这里，顺序：歌单引用 → 播放记录 →
 * 下载记录 → 歌词 → 播放态 → 歌曲行 → `SONG.DELETED`。
 */

/**
 * 判断歌曲是否仍可被用户访问：
 *  - 本地歌曲 / 已下载到本地的歌曲（"本地与下载"页可访问）
 *  - 存在未完成、进行中的下载记录（"本地与下载"页可访问）
 *  - 仍被任意歌单引用
 *  - 仍存在播放记录（"最近播放"页可访问）
 * 满足任一即“可达”，不可回收。查询失败一律按「查不到」处理。
 */
async function isSongReachable(song: LP.Song): Promise<boolean> {
    // 1. 本地歌曲 或 已下载到本地的歌曲
    if (song.pluginId === 'local') return true
    if (song.downloadQualities?.some((q) => q.path)) return true

    // 2. 存在未完成、进行中的下载记录
    const dr = await getUnfinishedDownloadRecordBySongId(song.id)
    if (isOk(dr) && dr.value) return true

    // 3. 仍被任意歌单引用
    const playlistIds = await getPlaylistIdsBySongId(song.id)
    if (isOk(playlistIds) && playlistIds.value.length > 0) return true

    // 4. 仍存在播放记录
    const stats = await getSongPlayedStatsBySongId(song.id)
    return isOk(stats) && Boolean(stats.value)
}

/**
 * 删除歌曲及其全部附属数据：
 * 歌单引用 → 播放记录 → 下载记录 → 歌词 → 重置当前播放 → 删除歌曲 → 触发 SONG.DELETED。
 */
async function removeSong(songId: string): Promise<void> {
    // 1-4. 并发清理可能存在的歌单引用、播放记录、下载记录和歌词
    await Promise.all([
        deletePlaylistSongsBySongId(songId),
        deleteSongPlayedStats(songId),
        deleteDownloadRecordsBySongId(songId),
        deleteSongLyric(songId)
    ])
    // 5. 若正播放该曲，重置播放态
    const player = usePlayerStore.getState()
    if (player.currentSong?.id === songId) player.resetCurrentSong()
    // 6. 删除歌曲记录
    await dbDeleteSong(songId)
    // 7. 触发事件
    eventBus.emit(LP_EVENT['SONG.DELETED'], songId)
}

/**
 * 删除歌曲
 * @returns 是否执行了删除（歌曲不存在则返回 false）
 */
export async function deleteSong(songId: string): Promise<boolean> {
    if (!songId) return false
    const song = await getSongById(songId)
    if (!isOk(song) || !song.value) return false
    await removeSong(songId)
    return true
}

/**
 * 若歌曲已无法被用户访问，则彻底删除；仍可达则跳过。
 * 不可达条件：非本地 / 已下载歌曲、无未完成下载记录、不被任何歌单引用、无播放记录。
 * @returns 是否执行了删除
 */
export async function cleanupSongIfUnreachable(songId: string): Promise<boolean> {
    if (!songId) return false
    const song = await getSongById(songId)
    if (!isOk(song) || !song.value) return false
    if (await isSongReachable(song.value)) return false
    await removeSong(songId)
    return true
}
