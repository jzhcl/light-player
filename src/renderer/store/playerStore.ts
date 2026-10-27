import { create } from 'zustand'

type PlayerState = {
    state: PlayState
    duration: number
    currentTime: number
    currentSong: LP.Song | null
    currentPlaybackQuality: Quality | null

    setState: (s: PlayState) => void
    setCurrentTime: (t: number) => void
    setDuration: (d: number) => void
    setCurrentSong: (s: LP.Song | null) => void
    resetCurrentSong: () => void
}

export const usePlayerStore = create<PlayerState>((set) => ({
    state: 'stopped',
    duration: 0,
    currentTime: 0,
    currentSong: null,
    currentPlaybackQuality: null,
    setState: (state) => set({ state }),
    setCurrentTime: (currentTime) => set({ currentTime }),
    setDuration: (duration) => set({ duration }),
    setCurrentSong: (currentSong) => set({ currentSong }),
    resetCurrentSong: () => set({ currentSong: null }),
}))

// 派生 selector
export const useIsPlaying = () => usePlayerStore((s) => s.state === 'playing')
