import { isOk, ok } from '@shared/result'
import { message } from '@renderer/lib/message'
import { idList, rlog } from '@renderer/lib/log'
import { addSongToPlaylist } from '@renderer/features/playlist/playlistService'
import { cleanupSongIfUnreachable, markSongLike, unmarkSongLike } from './songService'

/**
 * 歌曲域的常用 / 批量写操作（列表页与右键菜单共用）。
 *
 *  - `addSongsTo`：批量加入目标歌单（倒序）
 *  - `applyToSongs`：对一批歌逐个执行写操作（串行、失败不中断）
 *  - `toggleSongLike`：切一首歌的喜欢状态
 */

/** 批量操作的回执：全成功给正向文案，部分成功给「已完成 N，M 失败」 */
export function batchFeedback(
    done: number,
    failed: number,
    text: (n: number) => string,
): { type: 'success' | 'warn' | 'error'; text: string } {
    if (failed === 0) return { type: 'success', text: text(done) }
    if (done === 0) return { type: 'error', text: `${failed} 个处理失败` }
    return { type: 'warn', text: `${text(done)}，${failed} 个失败` }
}

/**
 * 导入类操作的回执：把「成功 / 已存在 / 失败」三段拼成一句话。
 *
 * 与 `batchFeedback` 分开是因为导入多出「已存在」这一段 —— 它不是失败，
 * 但用户也需要知道自己选的 20 个文件里为什么只多了 12 首。
 */
export function importFeedback(
    added: number,
    existing: number,
    failed: number,
): { type: 'success' | 'warn' | 'error' | 'info'; text: string } {
    const parts: string[] = []
    if (added > 0) parts.push(`已导入 ${added} 首`)
    if (existing > 0) parts.push(`${existing} 首已存在`)
    if (failed > 0) parts.push(`${failed} 首失败`)
    if (parts.length === 0) return { type: 'info', text: '没有可导入的文件' }
    const type = failed > 0 ? (added > 0 ? 'warn' : 'error') : added > 0 ? 'success' : 'info'
    return { type, text: parts.join('，') }
}

/** 批量添加的目标：我喜欢，或某个具体歌单（只需 id + 名字，用来拼提示语） */
export type AddTarget = { kind: 'liked' } | { kind: 'playlist'; playlist: Pick<LP.Playlist, 'id' | 'name'> }

export function addSongsTo(items: readonly LP.Song[], target: AddTarget): Promise<void>
export function addSongsTo<T>(
    items: readonly T[],
    target: AddTarget,
    resolveSong: (item: T) => Promise<Result<LP.Song>>,
): Promise<void>

/**
 * 把一批歌曲加入目标，并统一给出提示。
 *
 * @param items 待添加的条目
 * @param target 添加目标
 * @param resolveSong 逐条转成库内歌曲；返回失败计一次失败并跳过。
 *        搜索页用它在入库前把插件歌曲落库（`ensureSong`）。
 */
export async function addSongsTo(
    items: readonly unknown[],
    target: AddTarget,
    resolveSong?: (item: unknown) => Promise<Result<LP.Song>>,
): Promise<void> {
    let added = 0
    let failed = 0
    const targetName = target.kind === 'liked' ? '「我喜欢」' : `「${target.playlist.name}」`

    // 倒序遍历
    for (let i = items.length - 1; i >= 0; i--) {
        const item = items[i]
        // 无 resolver 时 items 已声明为 LP.Song[]（见重载），这里的断言由重载保证
        const songR = resolveSong ? await resolveSong(item) : ok(item as LP.Song)
        if (!isOk(songR)) {
            failed++
            continue
        }
        const song = songR.value

        if (target.kind === 'liked') {
            // 已喜欢：既不算新增也不算失败
            if (song.isLiked) continue
            // 走 markSongLike
            const r = await markSongLike(song.id)
            if (!isOk(r)) {
                failed++
                continue
            }
            added++
            continue
        }

        // 已在歌单：Result 只表示「操作成功」，靠出参区分「真加了」与「早就有」
        const inserted = { inserted: false }
        const r = await addSongToPlaylist(target.playlist.id, song.id, undefined, inserted)
        if (!isOk(r)) {
            failed++
            continue
        }
        if (!inserted.inserted) continue
        added++
    }

    const targetId = target.kind === 'liked' ? 'liked' : target.playlist.id
    rlog.info(
        `[song] 添加到${targetName}：成功 ${added} 首${failed > 0 ? `，失败 ${failed} 首` : ''}\ntargetId: ${targetId}`,
    )

    // 一首没加、也没失败 = 全都已经在里面了，这是常态而非错误
    if (added === 0 && failed === 0) {
        message.info(`所选歌曲已全部在${targetName}中`)
        return
    }
    const fb = batchFeedback(added, failed, (n) => `已将 ${n} 首歌曲添加到${targetName}`)
    message[fb.type](fb.text)
}

interface SongBatchOutcome {
    /** 成功的歌曲 id，按输入顺序 */
    done: string[]
    failed: number
}

/**
 * 对一批歌逐个执行写操作：串行、单首失败不中断整批，成功的顺带回收孤儿曲目
 * （记录可能已不再被任何歌单 / 下载引用）。
 *
 * 这里只负责执行 + 记日志，不弹提示，
 * 由调用方拿 `done` / `failed` 自己拼。
 *
 * label 日志用，说明这批是在做什么（如「删除播放历史」）
 */
export async function applyToSongs<T extends { id: string }>(
    items: readonly T[],
    op: (item: T) => Promise<Result<unknown>>,
    label: string,
): Promise<SongBatchOutcome> {
    const done: string[] = []
    let failed = 0
    for (const item of items) {
        const r = await op(item)
        if (!isOk(r)) {
            failed++
            continue
        }
        done.push(item.id)
        void cleanupSongIfUnreachable(item.id)
    }
    rlog.info(
        `[song] ${label}：成功 ${done.length} 个${failed > 0 ? `，失败 ${failed} 个` : ''}\nids: ${idList(done)}`,
    )
    return { done, failed }
}

/**
 * 切换一首歌的喜欢状态（写库 + 同步「我喜欢」歌单）。
 *
 * 失败已在内部提示 → 返回 `null`；成功返回切换后的状态。
 */
export async function toggleSongLike(song: Pick<LP.Song, 'id' | 'isLiked'>): Promise<boolean | null> {
    const r = song.isLiked ? await unmarkSongLike(song.id) : await markSongLike(song.id)
    if (!isOk(r)) {
        message.error(`${song.isLiked ? '取消喜欢' : '喜欢'}失败：${r.error}`)
        return null
    }
    return !song.isLiked
}
