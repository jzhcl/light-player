import { useEffect, useMemo, useState } from 'react'
import { isOk } from '@shared/result'
import { LP_EVENT } from '@shared/event'
import type { PicLike } from '@renderer/components/ui/Cover'
import { isQueueRef, queueEntryKey, type QueueEntry } from '@renderer/features/song/songKey'
import { useEvent } from '@renderer/hooks/useEvent'
import { getSongsByIds } from '@renderer/lib/db'

/** 队列行的展示数据：已落库的 LP.Song 与未落库的插件歌曲归一后的形状 */
interface QueueDisplaySong {
    name: string
    singer: string
    duration: number
    pic?: PicLike
}

/**
 * 队列行
 */
export interface QueueRow {
    /** 队列项唯一键，同时用作 dnd-kit 的 sortable id */
    key: string
    entry: QueueEntry
    /** 展示数据；尚未解析出（或已失效）时为 null */
    song: QueueDisplaySong | null
    /** 已确认查不到（歌曲被删了）—— 与「还在解析」区分开，免得闪一下「不可用」 */
    missing: boolean
}

function fromSong(song: LP.Song): QueueDisplaySong {
    return { name: song.name, singer: song.singer, duration: song.duration, pic: song.pic }
}

function fromPluginSong(song: LP.Plugin.Song): QueueDisplaySong {
    return {
        name: song.name,
        singer: song.singer?.map((s) => s.name).join(' & ') ?? '',
        duration: song.duration,
        pic: song.pic,
    }
}

/**
 * 把播放队列解析成可渲染的行。
 *
 * 未落库的插件项直接映射（数据就在对象上，不用查库）；已落库的项按 id 批量查 songs 表，
 * 只在「出现新的未缓存 id」时才发起查询，查到的进缓存、查不到的记进 missing。
 * 缓存跨面板开合保留 —— 关掉再打开不会重新查一遍。
 *
 * @param queue 队列本体。面板关着也照传。
 * @param active 是否允许查库。面板关着传 false：行照算，只是不发查询
 */
export function useQueueView(queue: readonly QueueEntry[], active = true): QueueRow[] {
    const [cache, setCache] = useState<ReadonlyMap<string, LP.Song>>(() => new Map())
    const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set())

    useEffect(() => {
        if (!active) return
        const pending: string[] = []
        const seen = new Set<string>()
        for (const entry of queue) {
            if (!isQueueRef(entry)) continue
            if (cache.has(entry.id) || missing.has(entry.id)) continue
            if (seen.has(entry.id)) continue
            seen.add(entry.id)
            pending.push(entry.id)
        }
        if (pending.length === 0) return

        let cancelled = false
        void (async () => {
            const r = await getSongsByIds(pending)
            if (cancelled || !isOk(r)) return

            const found = new Map<string, LP.Song>()
            for (const song of r.value) found.set(song.id, song)
            // 查回来的数量对不上（有 id 查不到）→ 这些就是已失效的
            const gone = found.size === pending.length ? [] : pending.filter((id) => !found.has(id))

            setCache((prev) => {
                if (found.size === 0) return prev
                const next = new Map(prev)
                for (const [id, song] of found) next.set(id, song)
                return next
            })
            if (gone.length > 0) {
                setMissing((prev) => {
                    const next = new Set(prev)
                    for (const id of gone) next.add(id)
                    return next
                })
            }
        })()

        return () => {
            cancelled = true
        }
    }, [queue, cache, missing, active])

    // 歌曲被删除：把缓存挪进 missing，否则面板会一直显示一个已经播不了的幽灵行
    useEvent(LP_EVENT['SONG.DELETED'], (payload) => {
        if (typeof payload !== 'string') return
        const id = payload
        setCache((prev) => {
            if (!prev.has(id)) return prev
            const next = new Map(prev)
            next.delete(id)
            return next
        })
        setMissing((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
    })

    return useMemo(
        () =>
            queue.map((entry) => {
                const key = queueEntryKey(entry)
                if (isQueueRef(entry)) {
                    const song = cache.get(entry.id)
                    return {
                        key,
                        entry,
                        song: song ? fromSong(song) : null,
                        missing: missing.has(entry.id),
                    }
                }
                return { key, entry, song: fromPluginSong(entry), missing: false }
            }),
        [queue, cache, missing],
    )
}
