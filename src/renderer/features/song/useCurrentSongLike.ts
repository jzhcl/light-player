import { useCallback } from 'react'
import { LP_EVENT } from '@shared/event'
import { isOk } from '@shared/result'
import { message } from '@renderer/lib/message'
import { useEvent } from '@renderer/hooks/useEvent'
import { usePlayerStore } from '@renderer/store'
import { markSongLike, unmarkSongLike } from './songLike'

/**
 * 当前播放歌曲的「喜欢」状态与切换（底栏与播放页共用）。
 */
export function useCurrentSongLike(): { isLiked: boolean; toggle: () => void } {
    const isLiked = usePlayerStore((s) => s.currentSong?.isLiked === true)

    useEvent(LP_EVENT['SONG.LIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        const song = usePlayerStore.getState().currentSong
        if (id && song?.id === id) usePlayerStore.setState({ currentSong: { ...song, isLiked: true } })
    })
    useEvent(LP_EVENT['SONG.UNLIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        const song = usePlayerStore.getState().currentSong
        if (id && song?.id === id) usePlayerStore.setState({ currentSong: { ...song, isLiked: false } })
    })

    const toggle = useCallback(() => {
        const song = usePlayerStore.getState().currentSong
        if (!song) return
        void (async () => {
            const r = song.isLiked ? await unmarkSongLike(song.id) : await markSongLike(song.id)
            if (!isOk(r)) message.error(`${song.isLiked ? '取消喜欢' : '喜欢'}失败：${r.error}`)
        })()
    }, [])

    return { isLiked, toggle }
}
