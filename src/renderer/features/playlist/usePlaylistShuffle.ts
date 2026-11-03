import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { isOk } from '@shared/result'
import { message } from '@renderer/lib/message'
import { shufflePlaylistSongs } from './playlistService'

/**
 * 打乱歌单内歌曲顺序（写库，不可撤销）。
 *
 * 顺序的唯一来源是库：一条 SQL 在库内用 RANDOM() 重排 position 并回传新顺序，
 * 这里只按 id 映射回行数据 —— 不做本地洗牌，否则本地与库各随机一次，两边对不上。
 *
 * 因此也没有乐观更新：要等库返回才落 UI（本地 SQLite 一次几十毫秒），
 * 换来「屏幕上的顺序永远等于库里的顺序」；失败则 `reload()` 兜回真实顺序。
 * 同样不走 `PLAYLIST.SONG_POSITIONS_UPDATED` 事件回流 —— 触发源只有当前页这一个。
 */

export interface PlaylistShuffleOptions {
    playlistId: string
    /** 最新全量列表（按它把库返回的 id 映射回行数据，不能用渲染期闭包里的旧值） */
    listRef: RefObject<readonly LP.Song[]>
    setSongs: Dispatch<SetStateAction<LP.Song[]>>
    /** 落库失败 / 顺序对不齐 → 回到库里的真实顺序 */
    reload: () => void
}

export function usePlaylistShuffle({
    playlistId,
    listRef,
    setSongs,
    reload,
}: PlaylistShuffleOptions): () => void {
    return useCallback(() => {
        const list = listRef.current
        // 不足 2 首没有可打乱的余地（菜单项侧已禁用，这里再兜一层）
        if (list.length < 2) return
        void (async () => {
            const r = await shufflePlaylistSongs(playlistId)
            if (!isOk(r)) {
                message.error(`打乱顺序失败：${r.error}`)
                reload()
                return
            }
            const byId = new Map(list.map((s) => [s.id, s]))
            // RETURNING 给的是更新顺序，按 position 升序才是新的列表顺序
            const next = [...r.value]
                .sort((a, b) => a.position - b.position)
                .map((row) => byId.get(row.songId))
                .filter((s): s is LP.Song => s !== undefined)
            // 行数对不上说明这期间列表被事件回流增删过，残缺的顺序不可用 → 按库重载
            if (next.length !== list.length) {
                reload()
                return
            }
            setSongs(next)
            message.success('已打乱顺序')
        })()
    }, [playlistId, listRef, setSongs, reload])
}
