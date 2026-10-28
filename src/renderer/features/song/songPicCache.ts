import { getAllSongs } from '@renderer/lib/db'
import { isOk } from '@shared/result'
import { updateSong } from '@renderer/features/song/songWrite'
import { cacheSongPicture, parseAudioMetadata } from '@renderer/lib/audio'
import { downloadImage, imageExtFromUrl } from '@renderer/lib/download'
import { deleteFile, listDir } from '@renderer/lib/file'
import { generateId, join, normalizePath } from '@shared/utils'
import { useSettingsStore } from '@renderer/store'
import { rlog } from '@renderer/lib/log'
import type { FileInfo } from '@shared/types/file'

/** 重建并发度 */
const REBUILD_CONCURRENCY = 5

/** 歌曲封面缓存目录：`<cacheDir>/SongPic/` */
function songPicDir(): string {
    const cacheDir = useSettingsStore.getState().settings['path.cacheDir']
    return cacheDir ? join(cacheDir, 'SongPic') : ''
}

/**
 * 重建单首歌曲的封面缓存：
 *  - 网络歌曲（pic.url 存在）：从 url 经 downloadImage 下载落盘
 *  - 本地歌曲（pluginId='local'）：从音频源文件元数据重新抽取封面[0] 落盘
 *  - 无法重建：清空 pic.path
 * 返回重建后的路径（空串表示无图/失败）。
 */
async function rebuildSongPic(song: LP.Song): Promise<string> {
    let path = ''
    if (song.pic?.url) {
        // 网络歌曲
        const savePath = join(songPicDir(), `${generateId('pic')}.${imageExtFromUrl(song.pic.url)}`)
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

/** 清扫结果：删掉的文件数，以及「记录里有、盘上没了」需要重建的歌 */
interface SongPicSweepResult {
    deleted: number
    failed: number
    dangling: LP.Song[]
}

/**
 * 清扫歌曲图片缓存（回收站式，不是「全删再重建」）。
 *
 * 全在一份快照里算完，只读一次歌曲表 + 一次目录：
 *  - 目录里没被任何歌曲 `pic.path` 引用 → 删（换封面 / 重新解析 / 已删歌曲留下的旧图）
 *  - 0 字节（上次下载被打断留下的残骸）→ 删
 *  - 被引用但文件已不在 / 刚被删掉 → 记进 `dangling`，由调用方重建
 *
 * 健康缓存上这个操作是零删除、零下载、零写库。
 *
 * ⚠️ 不重建「`pic.path` 为空」的歌：那表示从没缓存过（或本就无图）。
 */
export async function sweepSongPics(): Promise<SongPicSweepResult> {
    const out: SongPicSweepResult = { deleted: 0, failed: 0, dangling: [] }
    const dir = songPicDir()
    if (!dir) return out

    const songsR = await getAllSongs()
    if (!isOk(songsR)) {
        rlog.warn(`[cache] 清扫歌曲封面跳过：读不到歌曲列表（${songsR.error}）`)
        return out
    }
    const entriesR = await listDir(dir)
    if (!isOk(entriesR)) return out

    // 盘上文件：归一化路径 → 目录项（保留原路径，删除时按原样传）
    const onDisk = new Map<string, FileInfo>()
    for (const f of entriesR.value) if (f.type === 'file') onDisk.set(normalizePath(f.path), f)

    const used = new Set<string>()
    for (const s of songsR.value) {
        const p = normalizePath(s.pic?.path)
        if (p) used.add(p)
    }

    // 一次性定出「要删的」与「要重建的」，再去删 —— 免得删完还要重列目录
    const doomed = new Set<string>()
    for (const [key, f] of onDisk) if (!used.has(key) || f.size === 0) doomed.add(key)

    // 只判「路径落在本目录里」的歌：`pic.path` 指向别处（改过缓存目录、历史遗留）时
    // 文件其实还在原处能正常显示，误判成悬空会让整个资料库重新下载一轮。
    const dirPrefix = `${normalizePath(dir)}/`
    for (const s of songsR.value) {
        const key = normalizePath(s.pic?.path)
        if (!key || !key.startsWith(dirPrefix)) continue
        if (!onDisk.has(key) || doomed.has(key)) out.dangling.push(s)
    }

    for (const key of doomed) {
        const f = onDisk.get(key)!
        const r = await deleteFile(f.path)
        if (isOk(r)) out.deleted++
        else out.failed++
    }

    return out
}

/**
 * 重建指定歌曲的封面缓存（并发 `REBUILD_CONCURRENCY`）。
 * 由「清除缓存」在 `sweepSongPics` 之后调用，且只传它挑出来的 `dangling`。
 */
export async function rebuildSongPics(songs: LP.Song[]): Promise<void> {
    if (songs.length === 0) return

    rlog.info(`[cache] 封面重建开始：${songs.length} 首`)
    let empty = 0
    let rejected = 0
    for (let i = 0; i < songs.length; i += REBUILD_CONCURRENCY) {
        const batch = songs.slice(i, i + REBUILD_CONCURRENCY)
        const results = await Promise.allSettled(batch.map((s) => rebuildSongPic(s)))
        for (const r of results) {
            if (r.status === 'rejected') rejected++
            // `rebuildSongPic` 内部不抛：重建不出来时返回空串，所以「没拿到封面」要单列，
            // 否则全失败也会显示成「全部完成」。
            else if (!r.value) empty++
        }
    }
    const summary = `[cache] 封面重建完成：${songs.length} 首，未拿到封面 ${empty} 首`
    if (rejected > 0) rlog.warn(`${summary}，异常 ${rejected} 首`)
    else rlog.info(summary)
}
