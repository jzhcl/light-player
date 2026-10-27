import { ok, isOk } from '@shared/result'
import { dbCreate, dbDelete, dbFind, dbQuery, dbUpdate } from './base'


export function normalizeSong(row: Record<string, unknown>): LP.Song {
    const song = row as unknown as LP.Song
    return {
        ...song,
        isLiked: Boolean(song.isLiked),
    }
}

export async function getSongById(songId: string): Promise<Result<LP.Song | null>> {
    const res = await dbFind('songs', { id: songId })
    if (!isOk(res)) return res
    return ok(res.value ? normalizeSong(res.value) : null)
}

export async function getSongsByIds(songIds: string[]): Promise<Result<LP.Song[]>> {
    if (songIds.length === 0) return ok([])
    const placeholders = songIds.map(() => '?').join(', ')
    const res = await dbQuery(
        `SELECT *
         FROM songs
         WHERE id IN (${placeholders})`,
        songIds,
    )
    if (!isOk(res)) return res
    const songMap = new Map(res.value.map((r) => [r.id as string, normalizeSong(r)]))
    // 保持输入顺序
    return ok(songIds.map((id) => songMap.get(id)).filter(Boolean) as LP.Song[])
}

/**
 * 按 (plugin_id, plugin_song_id) 批量查 songs 表，返回已入库的 LP.Song 记录。
 * 入参为空数组时直接返回空列表。
 * 返回顺序不保证与入参一致，调用方需自行按 pluginSongId 建 Map 匹配。
 */
export async function getSongsByPluginSongs(pluginId: string, pluginSongIds: string[]): Promise<Result<LP.Song[]>> {
    if (pluginSongIds.length === 0) return ok([])
    const placeholders = pluginSongIds.map(() => '?').join(', ')
    const res = await dbQuery(
        `SELECT *
         FROM songs
         WHERE plugin_id = ?
           AND plugin_song_id IN (${placeholders})`,
        [pluginId, ...pluginSongIds],
    )
    if (!isOk(res)) return res
    return ok(res.value.map(normalizeSong))
}

// 本地歌曲以 plugin_id = 'local' 判定
export async function getLocalSongs(): Promise<Result<LP.Song[]>> {
    const res = await dbQuery("SELECT * FROM songs WHERE plugin_id = 'local'")
    if (!isOk(res)) return res
    return ok(res.value.map(normalizeSong))
}

/**
 * 本地歌曲超集：
 * 原生导入(plugin_id = 'local') + 由 LightPlayer 下载到本地(download_qualities 非空)。
 */
export async function getLocalSongsAll(): Promise<Result<LP.Song[]>> {
    const res = await dbQuery(
        `SELECT * FROM songs
         WHERE plugin_id = 'local'
            OR (download_qualities IS NOT NULL AND download_qualities != '' AND download_qualities != '[]')`,
    )
    if (!isOk(res)) return res
    return ok(res.value.map(normalizeSong))
}

/** 全表扫描歌曲 */
export async function getAllSongs(): Promise<Result<LP.Song[]>> {
    const res = await dbQuery('SELECT * FROM songs')
    if (!isOk(res)) return res
    return ok(res.value.map(normalizeSong))
}

export async function searchSongs(keyword: string): Promise<Result<LP.Song[]>> {
    if (!keyword) return ok([])
    const kw = `%${keyword.toLowerCase()}%`
    const res = await dbQuery(
        `SELECT *
         FROM songs
         WHERE LOWER(name) LIKE ?
            OR LOWER(name_pinyin) LIKE ?
            OR LOWER(singer) LIKE ?
            OR LOWER(singer_pinyin) LIKE ?
            OR LOWER(album) LIKE ?
            OR LOWER(album_pinyin) LIKE ?`,
        [kw, kw, kw, kw, kw, kw],
    )
    if (!isOk(res)) return res
    return ok(res.value.map(normalizeSong))
}

export async function createSong(song: Omit<LP.Song, 'createdAt' | 'updatedAt'>): Promise<Result<boolean>> {
    return dbCreate('songs', { ...song })
}

export async function updateSong(songId: string, data: Partial<LP.Song>): Promise<Result<boolean>> {
    return dbUpdate('songs', { id: songId }, { ...data })
}

export async function deleteSong(songId: string): Promise<Result<number>> {
    return dbDelete('songs', { id: songId })
}
