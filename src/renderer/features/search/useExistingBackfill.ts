import { useCallback, useEffect, useRef, useState } from 'react'
import { isOk } from '@shared/result'
import { songKey } from '@renderer/features/song/songKey'
import { getSongsByIds, getSongsByPluginSongs } from '@renderer/lib/db'

/**
 * 搜索结果里「已入库歌曲」的回填（`id` / `isLiked`）。
 *
 *  - 只查本次新增*的 key（`seen` 记「已尝试过的」，未入库的也记 —— 否则每页都会重查一遍）；
 *  - 结果按 key 合并进旧 Map：没命中的老 key 继续持有原来的对象，行对象身份不变；
 *  - 中途取消不写 `seen`：那批 id 还没查完，下次 `songs` 变化要能重新扫到（否则会漏回填）。
 *
 * @param songs    当前可见的搜索结果（翻页会变长）
 * @param resetKey 关键词 + 插件集合；变了就清空（新搜索不继承旧回填）
 */
export interface ExistingBackfill {
    map: ReadonlyMap<string, LP.Song>
    /** 就地更新一行（点喜欢后 `id` 落定 / `isLiked` 取反）；同时标记「已入库，不必再查」 */
    patch: (key: string, song: LP.Song) => void
    /**
     * 按库 id 改喜欢（跨页回流用）：`SONG.LIKED` / `SONG.UNLIKED` 只带库 id，
     * 而本表按「插件 + 插件内 id」的合成键索引。
     *
     * 命中 → 就地打标；未命中（本页这行当时还没入库，回填只会记「查过、没找到」）
     * → 按 id 查库拿到合成键，整条补进表里。
     */
    patchLikeById: (id: string, isLiked: boolean) => void
}

interface BackfillStore {
    key: string
    map: Map<string, LP.Song>
}

interface SeenBucket {
    key: string
    ids: Set<string>
}

/** 空表常量：避免每次渲染新建 Map，让下游按引用比较时稳定 */
const EMPTY: ReadonlyMap<string, LP.Song> = new Map()

export function useExistingBackfill(
    songs: readonly LP.Plugin.Song[],
    resetKey: string,
): ExistingBackfill {
    const [store, setStore] = useState<BackfillStore>(() => ({ key: resetKey, map: new Map() }))
    const seenRef = useRef<SeenBucket>({ key: resetKey, ids: new Set() })
    const resetKeyRef = useRef(resetKey)
    resetKeyRef.current = resetKey
    // 回填表的渲染期快照：按库 id 反查合成键要同步读到最新表，不能等下一次渲染
    const mapRef = useRef<ReadonlyMap<string, LP.Song>>(EMPTY)

    /** 换关键词 / 插件集合后第一次触及 seen 时重建桶 */
    const seenOf = (key: string): Set<string> => {
        if (seenRef.current.key !== key) seenRef.current = { key, ids: new Set() }
        return seenRef.current.ids
    }

    const patch = useCallback((key: string, song: LP.Song) => {
        const resetKeyNow = resetKeyRef.current
        seenOf(resetKeyNow).add(key)
        setStore((prev) => {
            const base = prev.key === resetKeyNow ? prev.map : new Map<string, LP.Song>()
            const next = new Map(base)
            next.set(key, song)
            return { key: resetKeyNow, map: next }
        })
    }, [])

    /** 按库 id 打「喜欢」标；回填表里没有这条 → 查库换成合成键再整条补进去 */
    const patchLikeById = useCallback((id: string, isLiked: boolean) => {
        for (const [key, song] of mapRef.current) {
            if (song.id !== id) continue
            patch(key, { ...song, isLiked })
            return
        }
        void (async () => {
            const r = await getSongsByIds([id])
            if (!isOk(r) || r.value.length === 0) return
            const song = r.value[0]
            const key = songKey(song.pluginId, song.pluginSongId)
            // 不在当前结果里（事件的歌是别处正在播的那首）→ 没有行要改，别把表撑大
            if (!songs.some((s) => songKey(s.pluginId ?? '', s.id) === key)) return
            patch(key, { ...song, isLiked })
        })()
    }, [patch, songs])

    useEffect(() => {
        const seen = seenOf(resetKey)
        const missing: { pid: string; id: string; key: string }[] = []
        for (const s of songs) {
            const k = songKey(s.pluginId ?? '', s.id)
            if (seen.has(k)) continue
            missing.push({ pid: s.pluginId ?? '', id: s.id, key: k })
        }
        if (missing.length === 0) return

        let cancelled = false
        void (async () => {
            const byPlugin = new Map<string, string[]>()
            for (const m of missing) {
                const arr = byPlugin.get(m.pid)
                if (arr) arr.push(m.id)
                else byPlugin.set(m.pid, [m.id])
            }

            const found = new Map<string, LP.Song>()
            for (const [pid, ids] of byPlugin) {
                const r = await getSongsByPluginSongs(pid, ids)
                if (cancelled) return
                if (!isOk(r)) continue
                for (const song of r.value) found.set(songKey(song.pluginId, song.pluginSongId), song)
            }
            if (cancelled) return

            // 到这里才算「查过了」：中途取消不标记，下次 songs 变化会重新扫到这批 id
            for (const m of missing) seen.add(m.key)
            if (found.size === 0) return

            setStore((prev) => {
                const base = prev.key === resetKey ? prev.map : new Map<string, LP.Song>()
                const next = new Map(base)
                for (const [k, song] of found) next.set(k, song)
                return { key: resetKey, map: next }
            })
        })()

        return () => {
            cancelled = true
        }
        // seenOf 是纯 ref 读写，不入依赖
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [songs, resetKey])

    const map = store.key === resetKey ? store.map : EMPTY
    mapRef.current = map

    return { map, patch, patchLikeById }
}
