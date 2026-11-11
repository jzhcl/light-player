import { fail, isOk, ok } from '@shared/result'
import { join } from '@shared/utils'
import { formatSize } from '@shared/format'
import { rlog } from '@renderer/lib/log'
import { createTaskQueue } from '@renderer/lib/taskQueue'
import { embedTags } from '@renderer/lib/audio'
import { isNetworkUrl } from '@renderer/lib/utils'
import { getFileInfo } from '@renderer/lib/file'
import { getDownloadRecordById, markDownloadRecordCompleted } from '@renderer/lib/db/downloadRecord'
import { getSongById } from '@renderer/lib/db/song'
import { getSongLyric } from '@renderer/features/lyrics/songLyricService'
import { updateSong } from '@renderer/features/song/songWrite'

/**
 * 下载完成后把封面与 LRC 写进音频文件。
 *
 * 封面直接给远程地址，由主进程抓一次字节写进标签。
 *
 * 写进去的收益是文件自描述：这份文件日后被当本地歌导入时，
 * 内嵌封面（`audio:extractCover`）与内嵌歌词都能直接读出来，拷到别的机器也不丢。
 */

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
 * 单首：取歌词 + 取封面 → 写文件。
 *
 * 返回 ok(false) 表示「没什么可写」（歌曲记录已不存在 / 没歌词也没封面 / 文件里本来就有）。
 */
async function embedOne(task: DownloadTask): Promise<Result<boolean>> {
    const recR = await getDownloadRecordById(task.id)
    if (!isOk(recR) || !recR.value?.songId) return ok(false)
    const rec = recR.value

    const songR = await getSongById(rec.songId)
    if (!isOk(songR) || !songR.value) return ok(false)
    const song = songR.value

    // 歌词：库里没有就让插件拉一次（getSongLyric 内部会把结果写回 song_lyrics）
    const lyrR = await getSongLyric(song)
    if (!isOk(lyrR)) rlog.warn(`[embed] 取歌词失败 ${song.name}：${lyrR.error}`)
    const lyric = isOk(lyrR) ? lyrR.value.lyric.trim() : ''

    // 封面：只接受远程地址（下载下来的插件歌必然是 http(s)）
    const coverUrl = isNetworkUrl(song.pic ?? '') ? song.pic : undefined
    // 两样都没有就别白跑一次 IPC
    if (!lyric && !coverUrl) return ok(false)

    const filePath = join(task.directory, task.filename)
    const r = await embedTags({ filePath, coverUrl, lyric: lyric || undefined })
    if (!isOk(r)) return fail(r.error)

    const wrote = [r.value.cover ? '封面' : '', r.value.lyric ? '歌词' : ''].filter(Boolean)
    if (wrote.length === 0) return ok(false)

    rlog.info(`[embed] ${task.filename} 已写入 ${wrote.join(' + ')}`)
    await refreshSize(task, song, rec.quality, filePath)
    return ok(true)
}

/**
 * 串行度与下载一致（主进程 MAX_CONCURRENT = 3），真正落盘的写操作只有几毫秒，
 * 慢的是前面的取歌词 / 取封面。失败重试两次：句柄刚释放时可能 EPERM。
 */
const queue = createTaskQueue({
    concurrency: 3,
    flushDelayMs: 300,
    maxAttempts: 3,
    retryDelaysMs: [1000, 5000],
    onGiveUp: (key, error) => rlog.warn(`[embed] 放弃写入标签 ${key}：${error}`),
})

/**
 * 把「给这份下载写封面与歌词」排进队列。
 *
 * 幂等且廉价：文件里已有封面/歌词时主进程直接跳过，不落盘；两样都没有则连 IPC 都不发。
 * 失败只记日志 —— 下载本身已经成功，补标签是锦上添花，不该把任务翻成 failed。
 */
export function enqueueEmbedTags(task: DownloadTask): void {
    if (task.status !== 'completed') return
    queue.enqueue(task.id, () => embedOne(task))
}
