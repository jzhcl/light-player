import { downloadImage, imageExtFromUrl } from '@renderer/lib/download'
import { extractCoverTo } from '@renderer/lib/audio'
import { createTaskQueue } from '@renderer/lib/taskQueue'
import { songDeleted } from '@renderer/lib/batchedEvents'
import { fail, isOk, ok } from '@shared/result'
import { generateId, join } from '@shared/utils'
import { useSettingsStore } from '@renderer/store'
import { rlog } from '@renderer/lib/log'
import { updateSong } from './songWrite'

/**
 * 封面物化管道。
 *
 * 把封面落盘从「创建一首歌」的同步路径上摘下来。
 * 封面是缓存，不是歌曲的属性 —— 它可以晚一点存在，甚至可以不存在。
 *
 * 三种状态：
 *  - `pic == null`            → 确实没有封面（终态，不再试）
 *  - `pic.{url, path: ''}`    → 待物化（重启后可重建）
 *  - `pic.{url, path}`        → 已物化
 *
 * 分层：排队与重试交给 `lib/taskQueue`；本模块只定义「物化一首歌」这件事
 * （来源判定 + 落盘 + 写回）；真正的 IO 是 `audio:extractCover`（主进程抽内嵌图）
 * 与 `download:downloadImage`（主进程下载）。
 */

/** 歌曲封面缓存目录：`<cacheDir>/SongPic/` */
export function songPicDir(): string {
    const cacheDir = useSettingsStore.getState().settings['path.cacheDir']
    return cacheDir ? join(cacheDir, 'SongPic') : ''
}

/**
 * 物化单首歌的封面：按来源落盘，不写库。
 *
 * 来源由行自身推导：
 *  - `pic.url` 存在 → 下载在线图
 *  - `pluginId === 'local'` → 从音频文件抽内嵌图（`pluginSongId` 就是文件路径）
 *  - 都没有 → `ok(null)`：这首确实没有封面
 *
 * `ok(null)` 与失败必须区分：前者是「没有封面」这一事实（调用方置终态），
 * 后者是临时失败（可重试）。
 */
export async function materializeSongCover(song: LP.Song): Promise<Result<string | null>> {
    const dir = songPicDir()
    if (!dir) return fail('缓存目录未设置')

    const url = song.pic?.url ?? ''
    const base = generateId('pic')
    if (url) {
        const dest = join(dir, `${base}.${imageExtFromUrl(url)}`)
        const r = await downloadImage(url, dest)
        if (!isOk(r)) return r
        return r.value ? ok(dest) : fail('封面下载失败')
    }
    if (song.pluginId === 'local' && song.pluginSongId) {
        return extractCoverTo(song.pluginSongId, dir, base)
    }
    return ok(null)
}

type Priority = 'high' | 'normal'

/**
 * 排队权重。
 *  - 本地歌没有 url，`path` 空就真的没图 → 永远排在插件歌前面
 *  - 插件歌有 `pic.url`，即使还没落盘，界面也用它兜底显示 → 排在后面
 * 同一档内再按是否正在播放分先后（正在播的那首马上就要显示图）。
 */
const PRIORITY = {
    localHigh: 5,
    localNormal: 4,
    pluginHigh: 3,
    pluginNormal: 2,
} as const

/** 在线的封面同时最多排这么多首；本地歌没有 url 兜底，不受此限 */
const PLUGIN_PENDING_LIMIT = 100

const queue = createTaskQueue({
    concurrency: 5,
    // 入队后静默 400ms = 「批末」：导入 200 首只跑一轮，而不是每首各踢一次
    flushDelayMs: 400,
    maxAttempts: 3,
    retryDelaysMs: [1000, 5000, 20000],
    onGiveUp: (id, error) => rlog.warn(`[cover] 放弃物化 ${id}：${error}`),
})

function weightOf(song: LP.Song, priority: Priority): number {
    const local = song.pluginId === 'local'
    if (priority === 'high') return local ? PRIORITY.localHigh : PRIORITY.pluginHigh
    return local ? PRIORITY.localNormal : PRIORITY.pluginNormal
}

/** 物化一首并把结果写回歌曲行（失败交给队列重试） */
async function applyCover(song: LP.Song): Promise<Result<unknown>> {
    const r = await materializeSongCover(song)
    if (!isOk(r)) return fail(r.error)
    const path = r.value ?? ''
    // 拿到路径 → 写回；确实没有内嵌图 → 置 null（终态，之后不会再被入队）
    const w = await updateSong(
        song.id,
        path ? { pic: { url: song.pic?.url ?? '', path } } : { pic: undefined },
    )
    return w
}

/**
 * 把一首歌排进封面物化队列。
 *
 * 幂等且廉价：已物化 / 确实没封面 / 已放弃 / 缓存目录未设置的歌会直接返回，
 * 可以在任何地方放心调用。`high` 给「马上要显示大图」的场景（播放）。
 */
export function enqueueCover(song: LP.Song | null | undefined, priority: Priority = 'normal'): void {
    if (!song?.id) return
    // 没有 pic = 确实没有封面（终态）；有 path = 已物化。两者都不用排队
    if (!song.pic || song.pic.path) return
    if (!songPicDir()) return // 缓存目录未设置：直接跳过
    // 在线封面排满了就先不收（在线仍可按 url 显示，只是离线没图）；本地歌与播放中的照收
    if (song.pic.url && priority !== 'high' && queue.size() >= PLUGIN_PENDING_LIMIT) return
    const weight = weightOf(song, priority)
    queue.enqueue(song.id, () => applyCover(song), weight)
}

// 歌曲被删 → 立刻出队，避免为已经不存在的行写库（聚合流：一次删歌单可能带上百首）
songDeleted.subscribe((ids) => {
    for (const id of ids) queue.cancel(id)
})

// 网络恢复后允许重试：离线期间攒下的「放弃」不该锁死一整个进程生命周期
window.addEventListener('online', () => queue.resetFailures())
