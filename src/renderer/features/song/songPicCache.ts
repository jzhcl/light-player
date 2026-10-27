import { getAllSongs } from '@renderer/lib/db'
import { isOk } from '@shared/result'
import { updateSong } from '@renderer/features/song/songService'
import { cacheSongPicture, parseAudioMetadata } from '@renderer/lib/audio'
import { downloadImage, imageExtFromUrl } from '@renderer/lib/download'
import { generateId, join } from '@shared/utils'
import { useSettingsStore } from '@renderer/store'
import { rlog } from '@renderer/lib/log'


/**
 * 重建单首歌曲的封面缓存：
 *  - 网络歌曲（pic.url 存在）：从 url 经 downloadImage 下载落盘
 *  - 本地歌曲（pluginId='local'）：从音频源文件元数据重新抽取封面[0] 落盘
 *  - 无法重建：清空 pic.path
 * 返回重建后的路径（空串表示无图/失败）。
 */
export async function rebuildSongPic(song: LP.Song): Promise<string> {
    const cacheDir = useSettingsStore.getState().settings['path.cacheDir']
    let path = ''
    if (song.pic?.url && cacheDir) {
        // 网络歌曲
        const savePath = join(cacheDir, 'SongPic', `${generateId('pic')}.${imageExtFromUrl(song.pic.url)}`)
        const r = await downloadImage(song.pic.url, savePath)
        if (isOk(r) && r.value) path = savePath
    } else if (song.pluginId === 'local' && song.pluginSongId) {
        // 本地歌曲：从音频源文件重新抽取内嵌封面[0]（原始 Uint8Array 字节）落盘
        const metaR = await parseAudioMetadata(song.pluginSongId)
        if (isOk(metaR) && metaR.value.common.picture?.length) {
            const pic = metaR.value.common.picture[0]
            path = await cacheSongPicture(pic.data, pic.format)
        }
    }

    await updateSong(song.id, { pic: { url: song.pic?.url ?? '', path } })
    return path
}

/**
 * 图片缓存失效处理：扫描全部可重建封面的歌曲，分批重建。
 * 由「清除缓存」功能在删除 SongPic 分类后调用。
 *
 * 可重建的判据 = 有 `pic.url`（网络歌，重下）或本地歌（从源文件重抽内嵌封面）。
 */
export async function invalidatePicCache(): Promise<void> {
    const REBUILD_CONCURRENCY = 5
    const songs = await getAllSongs()
    if (!isOk(songs)) {
        rlog.warn(`[cache] 封面重建跳过：读不到歌曲列表（${songs.error}）`)
        return
    }
    const needRebuild = songs.value.filter((s) => s.pic?.url || (s.pluginId === 'local' && s.pluginSongId))
    if (needRebuild.length === 0) {
        rlog.info('[cache] 封面重建：没有需要重建的歌')
        return
    }

    rlog.info(`[cache] 封面重建开始：${needRebuild.length} 首`)
    let empty = 0
    let rejected = 0
    for (let i = 0; i < needRebuild.length; i += REBUILD_CONCURRENCY) {
        const batch = needRebuild.slice(i, i + REBUILD_CONCURRENCY)
        const results = await Promise.allSettled(batch.map((s) => rebuildSongPic(s)))
        for (const r of results) {
            if (r.status === 'rejected') rejected++
            // `rebuildSongPic` 内部不抛：重建不出来时返回空串，所以「没拿到封面」要单列，
            // 否则全失败也会显示成「全部完成」。
            else if (!r.value) empty++
        }
    }
    const summary = `[cache] 封面重建完成：${needRebuild.length} 首，未拿到封面 ${empty} 首`
    if (rejected > 0) rlog.warn(`${summary}，异常 ${rejected} 首`)
    else rlog.info(summary)
}
