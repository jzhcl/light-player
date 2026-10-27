declare namespace LP {
    /**
     * song_lyrics 表
     */

    /** 卡拉 OK 逐字歌词行（krc 格式） */
    interface KrcLine {
        /** 行的起始时间，毫秒 */
        start: number
        /** 行的持续时间，毫秒 */
        duration: number
        /** 逐字/词数组 */
        words: {
            /** 字/词的起始时间，毫秒 */
            start: number
            /** 字/词的持续时间，毫秒 */
            duration?: number
            /** 字/词的结束时间，毫秒 */
            end?: number
            /** 字/词文本 */
            word: string
        }[]
    }

    interface SongLyric {
        /** 歌词所属的歌曲 ID */
        songId: string
        /** lrc 格式歌词文本 */
        lyric: string
        /** 翻译歌词文本 */
        tlyric?: string
        /** 卡拉 OK 逐字歌词（krc 格式） */
        klyric?: KrcLine[]
        /** 罗马音歌词：lrc 文本 或 与 klyric 对应的 krc 格式 */
        rlyric?: string | KrcLine[]
        /** 创建时间，YYYY-MM-DD HH:mm:ss */
        createdAt: string
        /** 最后更新时间，YYYY-MM-DD HH:mm:ss */
        updatedAt: string
    }
}
