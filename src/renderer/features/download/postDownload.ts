import { fail, isOk, ok } from '@shared/result'
import { join } from '@shared/utils'
import { formatSize } from '@shared/format'
import { rlog } from '@renderer/lib/log'
import { createTaskQueue } from '@renderer/lib/taskQueue'
import { embedTags } from '@renderer/lib/audio'
import { writeLyricFile } from '@renderer/lib/lyricFile'
import { isNetworkUrl } from '@renderer/lib/utils'
import { getFileInfo } from '@renderer/lib/file'
import { getDownloadRecordById, markDownloadRecordCompleted } from '@renderer/lib/db/downloadRecord'
import { getSongById } from '@renderer/lib/db/song'
import { getSongLyric } from '@renderer/features/lyrics/songLyricService'
import { useSettingsStore } from '@renderer/store'
import { updateSong } from '@renderer/features/song/songWrite'

/**
 * 下载收尾：一次取歌词，两处落地。
 *
 *  1. 歌词文件（设置项 `download.saveLyricFile`）：完整歌词数据（原文/翻译/罗马音/逐字）
 *     写到 `<userData>/download_lyric/`，与音频文件同名。
 *  2. 音频文件内嵌：只有原文 LRC —— 标准字段，拷到别的播放器也认。
 */

/**
 * 把完整歌词数据另存一份（设置项关闭时什么都不做）。
 * 与内嵌独立：音频文件里已有歌词也照样写，因为两者内容不同。
 */
async function saveLyricFile(filePath: string, song: LP.Song, data: LP.SongLyric): Promise<void> {
    if (!useSettingsStore.getState().settings['download.saveLyricFile']) return
    if (!data.lyric && !data.tlyric && !data.klyric?.length && !data.rlyric) return

    const payload: LP.LyricFile = {
        name: song.name,
        singer: song.singer,
        album: song.album,
        lyric: data.lyric,
        ...(data.tlyric ? { tlyric: data.tlyric } : {}),
        ...(data.klyric?.length ? { klyric: data.klyric } : {}),
        ...(data.rlyric ? { rlyric: data.rlyric } : {}),
    }
    const r = await writeLyricFile(filePath, payload)
    if (!isOk(r)) rlog.warn(`[download] 歌词文件写入失败 ${song.name}：${r.error}`)
}

/**
 * 写完标签后文件变大，把记录与歌曲里记的大小改成实际值。
 * 两边都只是展示用，任一失败都不影响下载结果，故静默。
 */
async function refreshSize(
    task: DownloadTask,
    song: LP.Song,
    quality: Quality | undefined,
    filePath: string,
): Promise<void> {
    const info = await getFileInfo(filePath)
    if (!info || info.type !== 'file') return
    const size = formatSize(info.size)
    await markDownloadRecordCompleted(task.id, filePath, size)
    if (!quality) return
    const cur = song.downloadQualities ?? []
    if (!cur.some((q) => q.type === quality)) return
    await updateSong(song.id, {
        downloadQualities: cur.map((q) => (q.type === quality ? { ...q, size } : q)),
    })
}

/**
 * 单首：取歌词 → 落歌词文件 → 内嵌封面与 LRC。
 *
 * 返回 ok(false) 表示「音频文件没动」（歌曲记录已不存在 / 没歌词也没封面 / 文件里本来就有）。
 */
async function enrich(task: DownloadTask): Promise<Result<boolean>> {
    const recR = await getDownloadRecordById(task.id)
    if (!isOk(recR) || !recR.value?.songId) return ok(false)
    const rec = recR.value

    const songR = await getSongById(rec.songId)
    if (!isOk(songR) || !songR.value) return ok(false)
    const song = songR.value

    const filePath = join(task.directory, task.filename)

    // 歌词：库里没有就让插件拉一次（getSongLyric 内部会把结果写回 song_lyrics）
    const lyrR = await getSongLyric(song)
    if (!isOk(lyrR)) rlog.warn(`[download] 取歌词失败 ${song.name}：${lyrR.error}`)
    const lyricData = isOk(lyrR) ? lyrR.value : null
    const lyric = lyricData?.lyric.trim() ?? ''

    if (lyricData) await saveLyricFile(filePath, song, lyricData)

    // 封面：只接受远程地址（下载下来的插件歌必然是 http(s)；file:// 是本地抽取图，没有可抓的来源）
    const coverUrl = isNetworkUrl(song.pic ?? '') ? song.pic : undefined
    // 两样都没有就别白跑一次 IPC
    if (!lyric && !coverUrl) return ok(false)

    const r = await embedTags({ filePath, coverUrl, lyric: lyric || undefined })
    if (!isOk(r)) return fail(r.error)

    const wrote = [r.value.cover ? '封面' : '', r.value.lyric ? '歌词' : ''].filter(Boolean)
    if (wrote.length === 0) return ok(false)

    rlog.info(`[download] ${task.filename} 已写入 ${wrote.join(' + ')}`)
    await refreshSize(task, song, rec.quality, filePath)
    return ok(true)
}

/**
 * 并发与下载一致（主进程 MAX_CONCURRENT = 3），真正落盘的写操作只有几毫秒，
 * 慢的是前面的取歌词 / 抓封面。失败重试两次：句柄刚释放时可能 EPERM。
 */
const queue = createTaskQueue({
    concurrency: 3,
    flushDelayMs: 300,
    maxAttempts: 3,
    retryDelaysMs: [1000, 5000],
    onGiveUp: (key, error) => rlog.warn(`[download] 放弃收尾 ${key}：${error}`),
})

/**
 * 把「给这份下载收尾」排进队列。
 *
 * 幂等且廉价：文件里已有封面/歌词时主进程直接跳过，不落盘；两样都没有则连 IPC 都不发。
 * 失败只记日志 —— 下载本身已经成功，收尾是锦上添花，不该把任务翻成 failed。
 */
export function enqueuePostDownload(task: DownloadTask): void {
    if (task.status !== 'completed') return
    queue.enqueue(task.id, () => enrich(task))
}
