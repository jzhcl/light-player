import { ok, isOk } from '@shared/result'
import { dbCreate, dbDelete, dbExecute, dbFind, dbQuery, dbUpdate } from './base'


export async function getPlaylistById(playlistId: string): Promise<Result<LP.Playlist | null>> {
    return dbFind<LP.Playlist>('playlists', { id: playlistId })
}

export async function getAllPlaylists(): Promise<Result<LP.Playlist[]>> {
    return dbQuery<LP.Playlist>('SELECT * FROM playlists')
}

export async function getPlaylistSongs(playlistId: string): Promise<Result<string[]>> {
    const res = await dbQuery<{ songId: string }>(
        'SELECT song_id FROM playlist_songs WHERE playlist_id = ? ORDER BY position',
        [playlistId],
    )
    if (!isOk(res)) return res
    return ok(res.value.map((r) => r.songId))
}

/** 删除某歌曲在所有歌单中的引用，返回删除行数。 */
export async function deletePlaylistSongsBySongId(songId: string): Promise<Result<number>> {
    return dbDelete('playlist_songs', { songId })
}

/** 反查：某歌曲被哪些歌单引用（用于回收判断）。返回 playlist_id 数组。 */
export async function getPlaylistIdsBySongId(songId: string): Promise<Result<string[]>> {
    const res = await dbQuery<{ playlistId: string }>(
        'SELECT playlist_id FROM playlist_songs WHERE song_id = ?',
        [songId],
    )
    if (!isOk(res)) return res
    return ok(res.value.map((r) => r.playlistId))
}

/**
 * 批量反查：每首歌所属的「第一个歌单」（按 position 升序取首个）。
 *
 * 返回 songId → playlistId。
 */
export async function getFirstPlaylistIdsBySongIds(songIds: string[]): Promise<Result<Map<string, string>>> {
    if (songIds.length === 0) return ok(new Map<string, string>())
    const placeholders = songIds.map(() => '?').join(', ')
    const res = await dbQuery(
        `SELECT song_id, playlist_id
         FROM playlist_songs
         WHERE song_id IN (${placeholders})
         ORDER BY position`,
        songIds,
    )
    if (!isOk(res)) return res
    const map = new Map<string, string>()
    for (const r of res.value) {
        const songId = r.songId as string
        if (!map.has(songId)) map.set(songId, r.playlistId as string)
    }
    return ok(map)
}

/**
 * 向歌单加入歌曲（默认插入到首部 position=0，并让其后的项后移；指定 position 时插入到该位置）。
 * 已存在则跳过（不视为失败，仍返回成功）。
 *
 * out 可选出参：回传本次是否真的新增了行（已存在时为 false）。
 *   `Result<boolean>` 的成功值只表示「操作成功」，承载不了「真加了 N 首」与「早就有了 N 首」的区别，
 *   故用出参旁路。
 */
export async function addSongToPlaylist(
    playlistId: string,
    songId: string,
    position?: number,
    out?: { inserted: boolean },
): Promise<Result<boolean>> {
    const existing = await dbFind('playlist_songs', { playlistId, songId })
    if (!isOk(existing)) return existing
    if (existing.value) {
        if (out) out.inserted = false
        return ok(true)
    }

    const pos = position ?? 0
    // 后移插入点及之后的项，保证 position 唯一连续（空歌单时 UPDATE 影响 0 行，首首项落 0）
    const shifted = await dbExecute(
        'UPDATE playlist_songs SET position = position + 1 WHERE playlist_id = ? AND position >= ?',
        [playlistId, pos],
    )
    if (!isOk(shifted)) return shifted
    const created = await dbCreate('playlist_songs', { playlistId, songId, position: pos })
    if (!isOk(created)) return created
    if (out) out.inserted = true
    return created
}

/** 从歌单移除歌曲，并前移其后各项以重排 position */
export async function removeSongFromPlaylist(playlistId: string, songId: string): Promise<Result<number>> {
    const row = await dbFind('playlist_songs', { playlistId, songId })
    if (!isOk(row)) return row
    const pos = (row.value as { position: number } | null)?.position

    const cleared = await dbDelete('playlist_songs', { playlistId, songId })
    if (!isOk(cleared)) return cleared

    if (pos != null) {
        const renumbered = await dbExecute(
            'UPDATE playlist_songs SET position = position - 1 WHERE playlist_id = ? AND position > ?',
            [playlistId, pos],
        )
        if (!isOk(renumbered)) return renumbered
    }
    return cleared
}

/**
 * 批量重排歌单内歌曲：`songIds` 的数组下标即新的 position。
 *
 * 给出 `range` 时只更新 `[min, max]` 这一段
 */
export async function updatePlaylistSongPositions(
    playlistId: string,
    songIds: string[],
    range?: { from: number; to: number },
): Promise<Result<number>> {
    if (songIds.length === 0) return ok(0)

    const lo = range ? Math.max(0, Math.min(range.from, range.to)) : 0
    const hi = range ? Math.min(songIds.length - 1, Math.max(range.from, range.to)) : songIds.length - 1
    if (hi < lo) return ok(0)

    const slice = songIds.slice(lo, hi + 1)
    const cases = slice.map(() => 'WHEN ? THEN ?').join(' ')
    const placeholders = slice.map(() => '?').join(',')
    const params: unknown[] = []
    slice.forEach((songId, i) => params.push(songId, lo + i))
    params.push(playlistId, ...slice)
    return dbExecute(
        `UPDATE playlist_songs SET position = CASE song_id ${cases} ELSE position END WHERE playlist_id = ? AND song_id IN (${placeholders})`,
        params,
    )
}

export async function createPlaylist(playlist: Omit<LP.Playlist, 'createdAt' | 'updatedAt'>): Promise<Result<boolean>> {
    return dbCreate('playlists', { ...playlist })
}

export async function updatePlaylist(playlistId: string, data: Partial<LP.Playlist>): Promise<Result<boolean>> {
    return dbUpdate('playlists', { id: playlistId }, { ...data })
}

export async function deletePlaylist(playlistId: string): Promise<Result<number>> {
    // 先清关联记录，再删歌单本身
    const cleared = await dbDelete('playlist_songs', { playlistId })
    if (!isOk(cleared)) return cleared
    return dbDelete('playlists', { id: playlistId })
}
