import { create } from 'zustand'
import { LIKED_PLAYLIST_ID } from '@renderer/lib/constants'

// 「我喜欢」是固定 ID 的特殊歌单，不进入动态歌单列表
const excludeLiked = (list: LP.Playlist[]) => list.filter((p) => p.id !== LIKED_PLAYLIST_ID)

interface PlaylistStore {
    /** 全部歌单（排除「我喜欢」） */
    playlists: LP.Playlist[]
    /** 整体替换（过滤「我喜欢」） */
    setPlaylists: (list: LP.Playlist[]) => void
    /** 新增或按 id 替换 */
    upsertPlaylist: (playlist: LP.Playlist) => void
    /** 按 id 局部更新 */
    patchPlaylist: (id: string, patch: Partial<LP.Playlist>) => void
    /** 按 id 移除 */
    removePlaylist: (id: string) => void
    /** 拖拽结束后的整体重排：按给定 id 顺序重建列表 */
    reorderPlaylistsTo: (ids: string[]) => void
}

export const usePlaylistStore = create<PlaylistStore>((set) => ({
    playlists: [],
    setPlaylists: (list) => set({ playlists: excludeLiked(list) }),
    upsertPlaylist: (playlist) =>
        set((s) => {
            if (playlist.id === LIKED_PLAYLIST_ID) return {}
            const idx = s.playlists.findIndex((p) => p.id === playlist.id)
            if (idx === -1) return { playlists: [...s.playlists, playlist] }
            const next = s.playlists.slice()
            next[idx] = playlist
            return { playlists: next }
        }),
    patchPlaylist: (id, patch) =>
        set((s) => ({
            playlists: s.playlists.map((p) => (p.id === id ? { ...p, ...patch } : p)),
        })),
    removePlaylist: (id) =>
        set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) })),
    reorderPlaylistsTo: (ids) =>
        set((s) => {
            const map = new Map(s.playlists.map((p) => [p.id, p]))
            const next: LP.Playlist[] = []
            for (const id of ids) {
                const p = map.get(id)
                if (p) {
                    next.push(p)
                    map.delete(id)
                }
            }
            // 顺序之外的（理论上不应出现）追加到末尾，保证不丢数据
            for (const p of map.values()) next.push(p)
            return { playlists: next }
        }),
}))
