import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { LP_EVENT } from '@shared/event'
import { useEvent } from '@renderer/hooks/useEvent'
import { songDeleted } from '@renderer/lib/batchedEvents'
import { player } from '@renderer/features/player/player'
import type { QueueEntry } from '@renderer/features/song/songKey'

/**
 * 歌曲列表在页面里的三种职责切片，各自独立、按需取用：
 *  - 播放（`useSongListPlayback`）：这份列表 ↔ 播放队列
 *  - 移除（`useSongListRemoval`）：从本地副本里删行，并清掉选区
 *  - 同步（`useSongListSync`）：库变更 → 就地投影到本地副本
 */

/** 播放动作的数据源：一个「全量列表」的 ref + 元素到队列项的转换 */
export interface SongListSource<T> {
    /**
     * 全量歌单列表的 ref（页面里通常就是 `songsRef`）。
     * ⚠️ 必须是全量而不是渐进渲染的可见前缀 —— 否则点第 10 首会把队列截成前 N 首。
     */
    listRef: RefObject<readonly T[]>
    /**
     * 元素 → 队列项。已落库歌曲传 `toQueueRef`（丢掉 meta / quality，只留身份三元组）；
     * 搜索结果本身就是 `LP.Plugin.Song`（队列项之一），传恒等即可。
     * 必须引用稳定：内联箭头函数会让 `playAll` / `playFromRow` 每次渲染换身份。
     */
    toEntry: (item: T) => QueueEntry
}

export interface SongListPlayback<T> {
    /** 整份列表设为播放队列，并从队首开始播（`setQueue` 会把 `currentSong` 归 null 并作废旧流 → 每次都是重新装载） */
    playAll: () => void
    /** 整份列表设为播放队列，并从源列表的第 index 行起播 */
    playFromRow: (index: number) => void
    /** 双击行：从该行起播 */
    activateRow: (item: T, index: number) => void
}

export function useSongListPlayback<T>({ listRef, toEntry }: SongListSource<T>): SongListPlayback<T> {
    const playAll = useCallback(() => {
        const list = listRef.current
        if (list.length === 0) return
        player.setQueue(list.map(toEntry))
        void player.play()
    }, [listRef, toEntry])

    const playFromRow = useCallback(
        (index: number) => {
            const list = listRef.current
            if (list.length === 0) return
            // 队列去重 / 打乱都会移动下标 → 传源下标进去，拿回「目标曲在新队列里的下标」
            const idx = player.setQueue(list.map(toEntry), index)
            void player.switchTo(idx).then(() => player.play())
        },
        [listRef, toEntry],
    )

    const activateRow = useCallback((_item: T, index: number) => playFromRow(index), [playFromRow])

    return { playAll, playFromRow, activateRow }
}

/** 移除动作的宿主状态：页面自己的 `[songs, setSongs]` 与 `[selection, setSelection]` */
export interface SongListRemovalState<T> {
    setSongs: Dispatch<SetStateAction<T[]>>
    setSelection: Dispatch<SetStateAction<Set<string>>>
}

export interface SongListRemoval {
    /**
     * 按 DB id 从列表里移除若干首（同时尝试清理选区）。
     *
     * ⚠️ 选区那一段目前实际是 no-op：`ids` 是库 id，而选区里存的是合成键
     * （`pluginId:pluginSongId`，见 `songKey.ts` 的 §key 分层），`dead.has(k)` 永远为 false
     * ⇒ 走的是「未命中、原样返回」那条路。搬家时按原样保留（不改行为），是否修另议。
     */
    removeSongs: (ids: string[]) => void
}

export function useSongListRemoval<T extends { id: string }>({
    setSongs,
    setSelection,
}: SongListRemovalState<T>): SongListRemoval {
    const removeSongs = useCallback(
        (ids: string[]) => {
            if (ids.length === 0) return
            const dead = new Set(ids)
            setSongs((prev) => (prev.some((s) => dead.has(s.id)) ? prev.filter((s) => !dead.has(s.id)) : prev))
            setSelection((prev) => {
                let hit = false
                for (const k of prev) {
                    if (dead.has(k)) {
                        hit = true
                        break
                    }
                }
                if (!hit) return prev
                const next = new Set(prev)
                for (const id of ids) next.delete(id)
                return next
            })
        },
        [setSongs, setSelection],
    )

    return { removeSongs }
}

/** 同步动作的宿主状态：页面自己的 `[songs, setSongs]` 与移除动作 */
export interface SongListSyncState<T> {
    setSongs: Dispatch<SetStateAction<T[]>>
    removeSongs: (ids: string[]) => void
}

export interface SongListSync<T> {
    /**
     * 把 `id` 那一行换成新字段（不命中则原样返回同一数组）
     */
    patchRow: (id: string, patch: Partial<T>) => void
}

/**
 * 让页面持有的歌曲列表副本与库保持一致。维护两条与页面无关的不变量：
 *  - 字段一致：`SONG.UPDATED` → 把那一条换成新值
 *  - 存在性一致：`SONG.DELETED` → 删掉那一行
 */
export function useSongListSync<T extends { id: string }>({
    setSongs,
    removeSongs,
}: SongListSyncState<T>): SongListSync<T> {
    const patchRow = useCallback(
        (id: string, patch: Partial<T>) => {
            setSongs((prev) => {
                if (!prev.some((row) => row.id === id)) return prev
                return prev.map((row) => (row.id === id ? { ...row, ...patch } : row))
            })
        },
        [setSongs],
    )

    useEvent(LP_EVENT['SONG.UPDATED'], (payload) => {
        const p = payload as { id?: string; patch?: Partial<LP.Song> } | undefined
        if (!p?.id || !p.patch) return
        // payload 契约是 `Partial<LP.Song>`（见 songWrite.ts 的 updateSong）
        patchRow(p.id, p.patch as Partial<T>)
    })
    useEffect(() => songDeleted.subscribe((ids) => removeSongs(ids)), [removeSongs])

    return { patchRow }
}
