declare namespace LP {
    /**
     * playlists 表
     */
    interface Playlist {
        /** 歌单在该程序中的唯一 ID */
        id: string
        /** 歌单源插件 ID */
        pluginId: string
        /** 歌单名称 */
        name: string
        /** 歌单描述 */
        description?: string
        /** 歌单封面（JSON）：在线地址或本地路径 */
        pic?: {
            url?: string
            path?: string
        }
        /** 其他元数据（JSON） */
        meta?: Record<string, unknown>
        /** 创建时间，YYYY-MM-DD HH:mm:ss */
        createdAt: string
        /** 最后更新时间，YYYY-MM-DD HH:mm:ss */
        updatedAt: string
    }
}
