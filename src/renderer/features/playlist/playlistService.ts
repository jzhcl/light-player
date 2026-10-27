import {
    addSongToPlaylist as dbAddSongToPlaylist,
    createPlaylist as dbCreatePlaylist,
    deletePlaylist as dbDeletePlaylist,
    getAllPlaylists,
    getPlaylistById,
    getPlaylistSongs as dbGetPlaylistSongs,
    removeSongFromPlaylist as dbRemoveSongFromPlaylist,
    updatePlaylist as dbUpdatePlaylist,
    updatePlaylistSongPositions as dbUpdatePlaylistSongPositions,
} from '@renderer/lib/db'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { cleanupSongIfUnreachable } from '@renderer/features/song/songService'
import { usePlaylistStore, useSettingsStore } from '@renderer/store'
import { rlog } from '@renderer/lib/log'
import { ok, isOk } from '@shared/result'


/**
 * 按用户保存的 playlist.order 排序；order 中缺失的新歌单追加到末尾。
 */
function applyPlaylistOrder(list: LP.Playlist[], order: string[]): LP.Playlist[] {
    if (!order?.length) return list
    const map = new Map(list.map((p) => [p.id, p]))
    const ordered: LP.Playlist[] = []
    for (const id of order) {
        const p = map.get(id)
        if (p) {
            ordered.push(p)
            map.delete(id)
        }
    }
    for (const p of map.values()) ordered.push(p)
    return ordered
}

/**
 * 生成不重复的默认歌单名：新建歌单1 / 新建歌单2 ...
 */
export function getNextPlaylistName(existing: Set<string>): string {
    let i = 1
    let name = `新建歌单${i}`
    while (existing.has(name)) {
        i++
        name = `新建歌单${i}`
    }
    return name
}

/**
 * 加载全部歌单到 store（排除「我喜欢」并由 playlist.order 排序），返回歌单个数
 */
export async function loadAllPlaylists(): Promise<number> {
    const list = await getAllPlaylists()
    if (!isOk(list)) {
        rlog.error(`[playlist] 加载歌单失败：${list.error}`)
        return 0
    }
    const order = useSettingsStore.getState().settings['playlist.order']
    const playlists = applyPlaylistOrder(list.value, order)
    usePlaylistStore.getState().setPlaylists(playlists)
    return usePlaylistStore.getState().playlists.length
}

/**
 * 新建歌单：写 DB + 更新 store
 */
export async function createPlaylist(
    data: Omit<LP.Playlist, 'createdAt' | 'updatedAt'>,
): Promise<Result<string>> {
    const r = await dbCreatePlaylist(data)
    if (!isOk(r)) return r
    const created = await getPlaylistById(data.id)
    if (isOk(created) && created.value) usePlaylistStore.getState().upsertPlaylist(created.value)
    else usePlaylistStore.getState().upsertPlaylist(data as LP.Playlist)
    rlog.info(`[playlist] 创建歌单「${data.name}」(${data.id})`)
    return ok(data.id)
}

/** 日志用：把字段值转成可读文本（空串 / undefined / 对象分开处理） */
const fmt = (v: unknown): string => {
    if (v === undefined) return '(无)'
    if (v === null) return '(null)'
    if (typeof v === 'string') return v === '' ? '(空)' : v
    if (typeof v === 'object') return JSON.stringify(v)
    return String(v)
}

/**
 * 更新歌单：写 DB + 更新 store
 */
export async function updatePlaylist(playlistId: string, patch: Partial<LP.Playlist>): Promise<Result<true>> {
    const found = usePlaylistStore.getState().playlists.find((p) => p.id === playlistId)
    const before = found ? { ...found } : undefined
    const r = await dbUpdatePlaylist(playlistId, patch)
    if (!isOk(r)) return r
    usePlaylistStore.getState().patchPlaylist(playlistId, patch)
    const after = usePlaylistStore.getState().playlists.find((p) => p.id === playlistId)
    const changes = Object.entries(patch)
        .map(
            ([key, next]) =>
                `  ${key}: ${fmt((before as Record<string, unknown> | undefined)?.[key])} → ${fmt(next)}`,
        )
        .join('\n')
    rlog.info(`[playlist] 更新歌单「${after?.name ?? playlistId}」(${playlistId})\n${changes}`)
    return ok(true)
}

/**
 * 删除歌单：
 *  1. 先取得歌单内歌曲 ID；
 *  2. 删除歌单与歌曲的引用；
 *  3. 删除歌单本身；
 *  4. 对每首歌曲异步回收；
 *  5. 更新 usePlaylistStore。
 */
export async function deletePlaylist(playlistId: string): Promise<Result<true>> {
    // 删除前先取名字：删完 store 里就没有了，日志里只剩一个 id 无从辨认
    const name = usePlaylistStore.getState().playlists.find((p) => p.id === playlistId)?.name
    // 1. 先取得歌单内歌曲 ID
    const songIds = await getPlaylistSongs(playlistId)

    // 2. 删除歌单与歌曲的引用
    const cleared = await dbDeletePlaylist(playlistId)
    if (!isOk(cleared)) return cleared

    // 3. 对每首歌曲异步回收
    if (isOk(songIds)) {
        for (const songId of songIds.value) {
            void cleanupSongIfUnreachable(songId)
        }
    }

    // 4. 更新 store
    usePlaylistStore.getState().removePlaylist(playlistId)
    rlog.info(`[playlist] 删除歌单「${name ?? playlistId}」(${playlistId})`)
    return ok(true)
}

/** 读取某歌单的歌曲 ID 列表。 */
export async function getPlaylistSongs(playlistId: string) {
    return dbGetPlaylistSongs(playlistId)
}

/**
 * 向歌单加入歌曲：写 DB 后 emit PLAYLIST.SONG_ADDED
 *
 * out 可选出参：回传本次是否真的新增（歌中已有该曲时为 false）。
 *   注意「已存在」仍走成功分支、依然 emit。
 */
export async function addSongToPlaylist(
    playlistId: string,
    songId: string,
    position?: number,
    out?: { inserted: boolean },
) {
    const r = await dbAddSongToPlaylist(playlistId, songId, position, out)
    if (!isOk(r)) return r
    eventBus.emit(LP_EVENT['PLAYLIST.SONG_ADDED'], { playlistId, songId })
    return r
}

/**
 * 从歌单移除歌曲：写 DB 后 emit PLAYLIST.SONG_REMOVED
 */
export async function removeSongFromPlaylist(playlistId: string, songId: string) {
    const r = await dbRemoveSongFromPlaylist(playlistId, songId)
    if (!isOk(r)) return r
    eventBus.emit(LP_EVENT['PLAYLIST.SONG_REMOVED'], { playlistId, songId })
    return r
}

/**
 * 拖拽重排歌单内歌曲：`songIds` 的顺序即新的 position，写库后 emit
 * PLAYLIST.SONG_POSITIONS_UPDATED
 */
export async function updatePlaylistSongPositions(
    playlistId: string,
    songIds: string[],
    range?: { from: number; to: number },
) {
    const r = await dbUpdatePlaylistSongPositions(playlistId, songIds, range)
    if (!isOk(r)) return r
    eventBus.emit(LP_EVENT['PLAYLIST.SONG_POSITIONS_UPDATED'], { playlistId, songIds })
    return r
}
