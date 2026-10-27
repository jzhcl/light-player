import { useCallback, useMemo, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { isOk } from '@shared/result'
import { DRAG_REORDER_MAX } from '@renderer/lib/constants'
import { songKey } from '@renderer/features/song/songKey'
import { updatePlaylistSongPositions } from './playlistService'

/**
 * 歌单内歌曲的顺序调整（拖拽 + 菜单「调整位置」）。
 *
 * 两件事必须一起看：
 *  - 乐观更新：`setSongs` 先落地，列表与拖拽落定在同一帧，不会先弹回原位再跳过去。
 *  - 落库只写 `[from, to]` 区间：区间外的前缀 / 后缀没变，不必重写。
 *
 * 与「添加到 / 移除」不同，这里不走事件回流 —— 重排只有本页一个触发源，
 * 走事件反而会多一次「先旧后新」的抖动；代价是落库失败要自己 `reload()` 兜回真实顺序。
 */


export type MoveMode = 'top' | 'end' | 'up' | 'down'

export interface PlaylistReorderOptions {
    playlistId: string
    /** 最新全量列表（重排要按它算，不能用渲染期闭包里的旧值） */
    listRef: RefObject<readonly LP.Song[]>
    setSongs: Dispatch<SetStateAction<LP.Song[]>>
    /** 落库失败 → 回到库里的真实顺序 */
    reload: () => void
    /** 当前行数（规模闸门用；传标量而不是数组，避免 sortable 每次渲染换身份） */
    count: number
    /**
     * 本歌单的歌曲列表是否已加载完成（空歌单也算完成）。
     * 规模闸门在它首次为 true 时按当时的 `count` 冻结，之后运行期不再翻。
     */
    loaded: boolean
}

export interface PlaylistReorder {
    /** 传给 `ListView` 的 `sortable`；超规模闸门时为 undefined（改走菜单） */
    sortable: { onReorder: (keys: string[], info: { from: number; to: number }) => void } | undefined
    /** 闸门的冻结结果（页面用它决定是否显示「拖拽排序不可用」提示） */
    dragEnabled: boolean
    /** 菜单版「调整位置」：把选中项整体摘出来再插到目标位置 */
    moveSelection: (targets: LP.Song[], mode: MoveMode) => void
}

export function usePlaylistReorder({
    playlistId,
    listRef,
    setSongs,
    reload,
    count,
    loaded,
}: PlaylistReorderOptions): PlaylistReorder {
    const persistOrder = useCallback(
        async (list: LP.Song[], range: { from: number; to: number }) => {
            const r = await updatePlaylistSongPositions(
                playlistId,
                list.map((s) => s.id),
                range,
            )
            if (!isOk(r)) {
                reload()
                return
            }
        },
        [playlistId, reload],
    )

    const handleReorder = useCallback(
        (keys: string[], info: { from: number; to: number }) => {
            const list = listRef.current
            // keys 与列表必须一一对应；对不上说明拖拽期间列表变过，放弃本次
            if (keys.length !== list.length) return
            const byKey = new Map(list.map((s) => [songKey(s.pluginId, s.pluginSongId), s]))
            const next: LP.Song[] = []
            for (const key of keys) {
                const song = byKey.get(key)
                if (!song) return
                next.push(song)
            }
            setSongs(next)
            void persistOrder(next, info)
        },
        [listRef, setSongs, persistOrder],
    )

    /**
     * 做法是「把选中项整体摘出来，再插到目标位置」—— 摘与插都保持原有相对顺序，
     * 所以多选时是一整块移动，而不是逐个移动（逐个会互相穿插）。
     * 各分支的插入位都用摘掉选中项之后的下标表达：单选时「上移 = 插到前一个未选中项之前」，
     * 与手上直觉一致。
     */
    const moveSelection = useCallback(
        (targets: LP.Song[], mode: MoveMode) => {
            const list = listRef.current
            const ids = new Set(targets.map((s) => s.id))
            const picked: LP.Song[] = []
            const rest: LP.Song[] = []
            for (const song of list) {
                if (ids.has(song.id)) picked.push(song)
                else rest.push(song)
            }
            const first = list.findIndex((s) => ids.has(s.id))
            if (first === -1) return

            const raw =
                mode === 'top'
                    ? 0
                    : mode === 'end'
                        ? rest.length
                        : mode === 'up'
                            ? first - 1
                            : first + 1
            const at = Math.max(0, Math.min(rest.length, raw))
            const next = [...rest.slice(0, at), ...picked, ...rest.slice(at)]

            // 首个 / 末个发生变化的下标即需要重写的区间
            let lo = -1
            let hi = -1
            for (let i = 0; i < list.length; i++) {
                if (list[i] !== next[i]) {
                    if (lo === -1) lo = i
                    hi = i
                }
            }
            // 已经在目标位置（最前 / 最后）时不写库，但要说一句，免得点了像没反应
            if (lo === -1) {
                return
            }
            setSongs(next)
            void persistOrder(next, { from: lo, to: hi })
        },
        [listRef, setSongs, persistOrder],
    )

    /**
     * 规模闸门：加载完成时按当时的歌曲数定一次，运行期不再翻。
     *
     * 为什么冻结：`ListView` 按闸门在 `Row` / `SortableRow` 之间换组件类型，运行期跨 500
     * 翻转会让 React 整表卸载重挂。
     *
     * 空歌单也冻结：否则「空歌单 → 加到 600 首」会一直保持可拖。
     */
    const gateRef = useRef<{ pid: string; enabled: boolean } | null>(null)
    if (gateRef.current === null || gateRef.current.pid !== playlistId) {
        if (loaded) gateRef.current = { pid: playlistId, enabled: count <= DRAG_REORDER_MAX }
    }
    const settled = gateRef.current !== null && gateRef.current.pid === playlistId
    // 加载完成前先按「可拖」渲染：此时列表通常还是空的，不会产生 sortable 开销
    const dragEnabled = settled ? gateRef.current!.enabled : true

    const sortable = useMemo(
        () => (dragEnabled ? { onReorder: handleReorder } : undefined),
        [dragEnabled, handleReorder],
    )

    return { sortable, dragEnabled, moveSelection }
}
