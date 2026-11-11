import { extractCoverTo } from '@renderer/lib/audio'
import { createTaskQueue } from '@renderer/lib/taskQueue'
import { songDeleted } from '@renderer/lib/batchedEvents'
import { fail, isOk, ok } from '@shared/result'
import { generateId, join } from '@shared/utils'
import { toFileUrl } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/store'
import { rlog } from '@renderer/lib/log'
import { updateSong } from './songWrite'

/**
 * 封面物化管道
 *
 * 分层：排队与重试交给 `lib/taskQueue`；本模块只定义「物化一首本地歌的封面」这件事
 * （落盘 + 写回）；真正的 IO 是 `audio:extractCover`（主进程抽内嵌图）。
 */

/** 歌曲封面缓存目录：`<cacheDir>/SongPic/` */
export function songPicDir(): string {
    const cacheDir = useSettingsStore.getState().settings['path.cacheDir']
    return cacheDir ? join(cacheDir, 'SongPic') : ''
}

/**
 * 抽一首本地歌的内嵌封面并落盘，返回写入路径。
 *
 * `ok(null)` = 这个文件确实没有内嵌图（终态）；
 * `fail` = 临时失败（缓存目录没配好、文件读不了），可重试。
 * 这个区别决定调用方是「置终态」还是「留给队列重试」。
 */
async function extractSongCover(song: LP.Song): Promise<Result<string | null>> {
    const dir = songPicDir()
    if (!dir) return fail('缓存目录未设置')
    // 本地歌的 pluginSongId 就是文件路径
    if (!song.pluginSongId) return ok(null)
    return extractCoverTo(song.pluginSongId, dir, generateId('pic'))
}

/** 物化一首并写回，返回落盘路径（`null` = 确认没有封面，已置终态） */
export async function materializeSongCover(song: LP.Song): Promise<Result<string | null>> {
    if (song.pluginId !== 'local') return fail('只有本地歌需要落盘封面')
    const r = await extractSongCover(song)
    if (!isOk(r)) return r
    const w = await updateSong(song.id, { pic: r.value ? toFileUrl(r.value) : '' })
    if (!isOk(w)) return w
    return ok(r.value)
}

type Priority = 'high' | 'normal'

const PRIORITY: Record<Priority, number> = {
    /** 正在播的那首马上要显示大图 */
    high: 2,
    normal: 1,
}

const queue = createTaskQueue({
    concurrency: 3,
    // 入队后静默 400ms = 「批末」：导入 200 首只跑一轮，而不是每首各踢一次
    flushDelayMs: 400,
    maxAttempts: 3,
    retryDelaysMs: [1000, 5000, 20000],
    onGiveUp: (id, error) => rlog.warn(`[cover] 放弃物化 ${id}：${error}`),
})

/**
 * 把一首歌排进封面物化队列。
 *
 * 幂等且廉价：插件歌（有远程地址）/ 已抽出 / 已确认没有封面 / 缓存目录未设置
 * 的歌会直接返回，可以在任何地方放心调用。`high` 给「马上要显示大图」的场景（播放）。
 */
export function enqueueCover(song: LP.Song | null | undefined, priority: Priority = 'normal'): void {
    if (!song?.id) return
    if (song.pluginId !== 'local') return
    // 已经是地址字符串（`file://` 抽出图 / `''` 确认没有封面）→ 不用再试
    if (typeof song.pic === 'string') return
    if (!songPicDir()) return // 缓存目录未设置：直接跳过
    queue.enqueue(song.id, () => materializeSongCover(song), PRIORITY[priority])
}

// 歌曲被删 → 立刻出队，避免为已经不存在的行写库（聚合流：一次删歌单可能带上百首）
songDeleted.subscribe((ids) => {
    for (const id of ids) queue.cancel(id)
})
