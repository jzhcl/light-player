/**
 * 下载任务状态
 */
type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'completed' | 'failed' | 'cancelled'

interface DownloadTask {
    /** 任务 id，作为 download_records 表 id */
    id: string
    /** electron-dl-manager 内部下载 id（任务启动后填充） */
    libId?: string
    /** 下载 URL */
    url: string
    /** 保存文件名 */
    filename: string
    /** 保存目录 */
    directory: string
    /** 是否覆盖同名文件 */
    overwrite?: boolean
    status: DownloadStatus
    /** 创建时间 */
    createdAt: number
    error?: string
    /** 0~1 */
    progress: number
    downloadedBytes?: number
    totalBytes?: number
    /** 下载速度（字节/秒） */
    downloadSpeed?: number
}