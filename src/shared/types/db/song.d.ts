declare namespace LP {
    /**
     * songs 表
     */
    interface Song {
        /** 歌曲在该程序中的唯一 ID */
        id: string
        /** 歌曲源插件 ID（本地歌曲为 'local'） */
        pluginId: string
        /** 歌曲在插件中的 ID（本地歌曲为文件路径），用于判断是否已入库 */
        pluginSongId: string
        /** 歌曲名称 */
        name: string
        namePinyin?: string
        /** 所属专辑名称 */
        album?: string
        albumPinyin?: string
        /** 歌手名称 */
        singer: string
        singerPinyin?: string
        /** 歌曲封面（JSON）：在线地址或本地路径 */
        pic?: {
            url?: string
            path?: string
        }
        /** 歌曲时长（秒） */
        duration: number
        /** 是否喜欢 */
        isLiked: boolean
        /** 本地已下载音质列表 */
        downloadQualities?: { type: Quality; path: string; size?: string }[]
        /** 支持的音质列表（JSON） */
        supportQualities?: { type: Quality; size?: string }[]
        /** 其他元数据（JSON） */
        meta?: Record<string, unknown>
        /** 创建时间，YYYY-MM-DD HH:mm:ss */
        createdAt: string
        /** 最后更新时间，YYYY-MM-DD HH:mm:ss */
        updatedAt: string
    }

    /**
     * 队列中「已落库歌曲」的最小身份载体
     */
    type QueueRef = Pick<Song, 'id' | 'pluginId' | 'pluginSongId'>
}
