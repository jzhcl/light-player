import { useCallback, useRef, useState } from 'react'
import { usePlaylistStore, useSettingsStore } from '@renderer/store'
import { ensurePlaylistPic } from './playlistPic'
import { updatePlaylist } from './playlistService'

/**
 * 歌单封面的「自动兜底」（设置项 `playlist.useSongCoverAsFallback`）。
 *
 * 自动兜底优先，但「移除封面」在当下必须真的生效。
 *  - 兜底：歌单自己没有封面、且列表里有带封面的歌 → 复制进 PlaylistPic 后写库；
 *  - 清空：用户手动移除封面 → 写空 pic；
 *
 * `pendingCover` 是「临时」的，不是「空封面的长期替身」
 * 它只在一次校准的窗口内非空（`sync()` 立刻置上、写库返回后清空）。若让它长期顶替空封面，
 * 用户点「移除封面」当场就会被它弹回去 —— 按钮变成假的。这条是判据的重点。
 */

export interface PlaylistAutoCover {
    /**
     * 校准窗口内的临时兜底封面；窗口外恒为 `undefined`。
     * 页面渲染封面时：歌单自己的 `pic` 优先，其次才是它。
     */
    pendingCover: LP.Song['pic'] | undefined
    /**
     * 有可用候选时校准一次。自带全部早退条件（设置关 / 无候选 / 歌单不存在 / 已有封面 / 正在校准），
     * 调用方可以无脑调，不必自己判。
     */
    sync: (candidate: LP.Song['pic'] | undefined) => void
}

export function usePlaylistAutoCover(playlistId: string): PlaylistAutoCover {
    const [pendingCover, setPendingCover] = useState<LP.Song['pic'] | undefined>(undefined)

    /**
     * 同一时刻只允许一次校准。批量拖入 N 个文件会连 emit N 条 `PLAYLIST.SONG_ADDED`，
     * 不挡的话 N 个校准会同时走到 `ensurePlaylistPic`（各自复制出不同文件名）→ N 张图 + N 次写库，
     * 最后只有一张被用上，其余进「未使用」等着被清缓存回收。
     */
    const busyRef = useRef(false)

    const sync = useCallback(
        (candidate: LP.Song['pic'] | undefined) => {
            if (busyRef.current) return
            if (!candidate?.url && !candidate?.path) return
            // 设置走 getState 而不用订阅：否则本回调身份随设置变化 → 页面的 load 跟着重建 → 白白重跑取数
            if (!useSettingsStore.getState().settings['playlist.useSongCoverAsFallback']) return

            const current = usePlaylistStore.getState().playlists.find((p) => p.id === playlistId)
            if (!current) return
            // `{ url: '', path: '' }`（用户移除过封面）在这里算「没有封面」，照常兜底 ——
            // 「切走后回来封面又有了」就是这一条产生的，属于既定行为。
            if (current.pic?.url || current.pic?.path) return

            busyRef.current = true
            setPendingCover(candidate)
            void (async () => {
                try {
                    const owned = await ensurePlaylistPic(candidate)
                    // 复制 / 下载都不通 → 保持原样（不写库，也不留一个骗人的兜底）
                    if (!owned) return
                    await updatePlaylist(playlistId, { pic: owned })
                } finally {
                    busyRef.current = false
                    // 写库成功时 store 里已经有 pic，兜底自然让位；写失败时也不该继续顶着
                    setPendingCover(undefined)
                }
            })()
        },
        [playlistId],
    )

    return { pendingCover, sync }
}
