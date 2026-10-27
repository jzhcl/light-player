declare namespace LP {
    /**
     * playlist_songs 表
     */
    interface PlaylistSong {
        /** 歌单 ID */
        playlistId: string
        /** 歌曲 ID */
        songId: string
        /** 歌曲在歌单中的位置（从 0 开始） */
        position: number
        /** 添加时间，YYYY-MM-DD HH:mm:ss */
        addedAt: string
    }
}
