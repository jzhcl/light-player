import { ok, isOk } from '@shared/result'
import { dbCreate, dbDelete, dbExec, dbExecute, dbFind, dbQuery, dbUpdate } from './base'
import { normalizeSong } from './song'
import { rlog } from '@renderer/lib/log'


/** 按歌曲 ID 查询播放统计 */
export async function getSongPlayedStatsBySongId(songId: string): Promise<Result<LP.SongPlayedStats | null>> {
    return dbFind<LP.SongPlayedStats>('song_played_stats', { songId })
}

/** 查询全部播放统计 */
export async function getAllSongPlayedStats(): Promise<Result<LP.SongPlayedStats[]>> {
    return dbQuery<LP.SongPlayedStats>('SELECT * FROM song_played_stats')
}

/** 新建播放统计 */
export async function createSongPlayedStats(stats: Omit<LP.SongPlayedStats, 'lastPlayedAt'>): Promise<Result<boolean>> {
    return dbCreate('song_played_stats', { ...stats })
}

/** 更新播放统计 */
export async function updateSongPlayedStats(
    songId: string,
    data: Partial<LP.SongPlayedStats>,
): Promise<Result<boolean>> {
    return dbUpdate('song_played_stats', { songId }, { ...data })
}

/** 删除播放统计，返回删除行数 */
export async function deleteSongPlayedStats(songId: string): Promise<Result<number>> {
    return dbDelete('song_played_stats', { songId })
}

/**
 * 递增播放次数：存在则 +1，不存在则建首条记录
 */
export async function incrementPlayedCount(songId: string): Promise<Result<boolean>> {
    const existing = await getSongPlayedStatsBySongId(songId)
    if (!isOk(existing)) return existing
    if (existing.value) {
        return dbUpdate('song_played_stats', { songId }, { playedCount: existing.value.playedCount + 1 })
    }
    return dbCreate('song_played_stats', { songId, playedCount: 1 })
}

/** 最近播放的歌曲（含 playedCount / lastPlayedAt），按最后播放时间倒序 */
export async function getRecentPlayedSongs(
    limit = 100,
): Promise<Result<(LP.Song & { playedCount: number; lastPlayedAt: string })[]>> {
    const res = await dbQuery(
        `SELECT s.*, sps.played_count, sps.last_played_at
         FROM song_played_stats sps
                  INNER JOIN songs s ON s.id = sps.song_id
         ORDER BY sps.last_played_at DESC
         LIMIT ?`,
        [limit],
    )
    if (!isOk(res)) return res
    return ok(
        res.value.map((r) => ({
            ...normalizeSong(r),
            playedCount: Number(r.playedCount ?? 0),
            lastPlayedAt: String(r.lastPlayedAt ?? ''),
        })),
    )
}

/** 批量判定这些歌是否已有播放记录，返回有记录者的 songId 集合（供检索建议标注「最近播放」）。 */
export async function getPlayedSongIds(songIds: string[]): Promise<Result<Set<string>>> {
    if (songIds.length === 0) return ok(new Set<string>())
    const placeholders = songIds.map(() => '?').join(', ')
    const res = await dbQuery(
        `SELECT song_id
         FROM song_played_stats
         WHERE song_id IN (${placeholders})`,
        songIds,
    )
    if (!isOk(res)) return res
    return ok(new Set(res.value.map((r) => r.songId as string)))
}

/** 清空全部播放统计。 */
export async function clearAllPlayedStats(): Promise<Result<boolean>> {
    return dbExec('DELETE FROM song_played_stats')
}

/**
 * 仅保留最近播放的 limit 条，删除更旧的（基于 last_played_at 倒序）。
 * 用于把播放记录控制在上限内（如 PLAYED_STATS_LIMIT），避免无限增长。幂等。
 */
export async function trimSongPlayedStats(limit = 500): Promise<Result<number>> {
    // 先数一下：没超上限就直接返回，省掉一次带子查询的全表 DELETE
    const counted = await dbQuery<{ n: number }>('SELECT COUNT(*) AS n FROM song_played_stats')
    if (!isOk(counted)) return counted
    const total = Number(counted.value[0]?.n ?? 0)
    if (total <= limit) return ok(0)

    rlog.info(`[stats] 播放记录 ${total} 条，超过上限 ${limit}，开始裁剪`)
    const trimmed = await dbExecute(
        `DELETE FROM song_played_stats
         WHERE song_id NOT IN (
             SELECT song_id FROM song_played_stats
             ORDER BY last_played_at DESC
             LIMIT ?
         )`,
        [limit],
    )
    if (isOk(trimmed)) rlog.info(`[stats] 裁剪完成：删除 ${trimmed.value} 条，保留 ${limit} 条`)
    return trimmed
}
