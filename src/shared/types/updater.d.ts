/**
 * 自动更新
 *
 * idle → checking →（available → downloading → downloaded）| not-available | error
 */
type UpdateStatus =
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'not-available'
    | 'error'

/** 下载进度，仅 downloading 期间有值 */
interface UpdateProgress {
    /** 0-100 */
    percent: number
    /** 已下载字节 */
    transferred: number
    /** 总字节（差分下载时是差分量，不是完整安装包体积） */
    total: number
    /** 瞬时速度，字节/秒 */
    bytesPerSecond: number
}

/**
 * 更新器快照。真相在主进程，渲染端只读。
 * 走 `update:getState` 拿初始值，之后靠 UPDATE.STATE / UPDATE.PROGRESS 两条通道推。
 */
interface UpdateState {
    status: UpdateStatus
    /** 当前运行版本，恒有值 */
    currentVersion: string
    /**
     * 服务器上的最新版本。
     * 任何一次检查成功之后都有值（available / not-available / downloading / downloaded），
     * 检查前或检查失败时为 null。
     */
    latestVersion: string | null
    /** 失败原因；仅 error 有值 */
    error: string | null
    /** 进度；仅 downloading 有值 */
    progress: UpdateProgress | null
}

/** 一条更新日志（对应一个 GitHub Release） */
interface ChangelogEntry {
    /** 语义化版本号，不带 v 前缀 */
    version: string
    /** 发布时间，ISO 8601 */
    date: string
    /** Release 正文（Markdown 原文） */
    notes: string
}
