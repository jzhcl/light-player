import { ok, isOk } from '@shared/result'
import { dbQuery } from './base'


/** 插件在程序中产生的数据量统计（卸载确认弹窗用） */
export interface PluginDataStats {
    /** 来源为该插件的歌曲总数 */
    songCount: number
    /** 其中已喜欢的数量 */
    likedCount: number
    /** 其中已下载到本地的数量（卸载后仍可播放） */
    downloadedCount: number
    /** 该插件创建的歌单数量 */
    playlistCount: number
}

/**
 * 统计某插件在程序中产生的数据量。
 *
 * 背景：卸载只删除 plugins / plugin_storage 行与插件目录（host.ts uninstallPlugin），
 * songs / playlists 记录会保留，但其在线服务（取链、歌词等）随插件消失而不可用；
 * download_qualities 非空的歌曲已有本地文件，不受影响。
 */
export async function getPluginDataStats(pluginId: string): Promise<Result<PluginDataStats>> {
    const songRes = await dbQuery<{ count: number; liked: number; downloaded: number }>(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(CASE WHEN is_liked = 1 THEN 1 ELSE 0 END), 0) AS liked,
                COALESCE(SUM(CASE WHEN download_qualities IS NOT NULL
                                   AND download_qualities != ''
                                   AND download_qualities != '[]'
                             THEN 1 ELSE 0 END), 0) AS downloaded
         FROM songs
         WHERE plugin_id = ?`,
        [pluginId],
    )
    if (!isOk(songRes)) return songRes

    const playlistRes = await dbQuery<{ count: number }>(
        'SELECT COUNT(*) AS count FROM playlists WHERE plugin_id = ?',
        [pluginId],
    )
    if (!isOk(playlistRes)) return playlistRes

    const song = songRes.value[0]
    return ok({
        songCount: song?.count ?? 0,
        likedCount: song?.liked ?? 0,
        downloadedCount: song?.downloaded ?? 0,
        playlistCount: playlistRes.value[0]?.count ?? 0,
    })
}
