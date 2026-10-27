import type { ParsedLyric } from '@renderer/store'

/** 歌词窗用得上的歌曲展示信息 */
export interface LyricSyncSong {
    name: string
    singer: string
}

/**
 * 主窗 → 歌词窗：「整包歌词」载荷（切歌时发一次，也是首帧快照的主体）
 */
export interface LyricSyncPayload {
    song: LyricSyncSong | null
    parsed: ParsedLyric | null
}

/**
 * 主窗 → 歌词窗：桌面歌词外观设置
 */
export interface DesktopLyricSettings {
    /** 显示行数 */
    lineCount: 1 | 2
    /** 双行下的排布：左右分离 / 居中 */
    align: 'center' | 'alternate'
    /** 主歌词行下方显示哪一支辅助行：不显示 / 翻译 / 罗马音 */
    secondaryLine: 'none' | 'translation' | 'roma'
    font: {
        family: string
        size: number
    }
    colorPalette: {
        played: string
        unplayed: string
    }
}
