declare namespace LP {
    /**
     * download_records 表
     */
    interface DownloadRecord {
        /** 下载任务 ID */
        id: string
        /** 关联的歌曲 ID */
        songId?: string
        /** 下载 URL */
        url?: string
        /** 保存路径 */
        filePath?: string
        /** 文件名 */
        fileName?: string
        /** 音质 */
        quality?: Quality
        /** 文件大小（字符串格式，如 "5.2 MB"） */
        size?: string
        /** 下载状态 */
        status: DownloadStatus
        /** 失败原因 */
        error?: string
        /** 已下载进度（0~1），暂停时落库 */
        progress?: number
        /** 启动残留清理标记（仅 initDownload 扫过时置 1，其余时期不更新） */
        scanned: number
        /** 创建时间，YYYY-MM-DD HH:mm:ss */
        createdAt: string
        /** 最后更新时间，YYYY-MM-DD HH:mm:ss */
        updatedAt: string
    }
}
