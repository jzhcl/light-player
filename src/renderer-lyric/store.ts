import { create } from 'zustand'
import type { ParsedLyric } from '@renderer/store'
import type { DesktopLyricSettings, LyricSyncSong } from '@renderer/features/desktopLyric/types'

/**
 * 桌面歌词窗自己的 store。
 * 这里的数据全部由主窗推送重建，歌词窗不读库、不解析。
 */
interface LyricWindowState {
    song: LyricSyncSong | null
    parsed: ParsedLyric | null
    playState: PlayState
    /** 播放进度（毫秒）。~4Hz 的低频量，可以进 store；逐字 60fps 由组件自己的 rAF 算。 */
    timeMs: number
    settings: DesktopLyricSettings | null

    setSong: (song: LyricSyncSong | null, parsed: ParsedLyric | null) => void
    setPlayState: (playState: PlayState) => void
    setTimeMs: (timeMs: number) => void
    setSettings: (settings: DesktopLyricSettings) => void
}

export const useLyricWindowStore = create<LyricWindowState>((set) => ({
    song: null,
    parsed: null,
    playState: 'stopped',
    timeMs: 0,
    settings: null,
    setSong: (song, parsed) => set({ song, parsed }),
    setPlayState: (playState) => set({ playState }),
    setTimeMs: (timeMs) => set({ timeMs }),
    setSettings: (settings) => set({ settings }),
}))
