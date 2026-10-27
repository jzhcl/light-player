declare namespace LP {
    /**
     * song_played_stats 表
     */
    interface SongPlayedStats {
        /** 歌曲 ID */
        songId: string
        /** 累计播放次数 */
        playedCount: number
        /** 最后播放时间，YYYY-MM-DD HH:mm:ss（更新时经触发器维护） */
        lastPlayedAt: string
    }
}
