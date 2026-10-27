/**
 * 应用事件常量定义
 */
export const LP_EVENT = {
    // ---- 歌曲生命周期 ----
    'SONG.CREATED': 'song:created',
    'SONG.UPDATED': 'song:updated',
    'SONG.DELETED': 'song:deleted',
    'SONG.LIKED': 'song:liked',
    'SONG.UNLIKED': 'song:unliked',
    // ---- 歌单内歌曲操作 ----
    'PLAYLIST.SONG_ADDED': 'playlist:songAdded',
    'PLAYLIST.SONG_REMOVED': 'playlist:songRemoved',
    'PLAYLIST.SONG_POSITIONS_UPDATED': 'playlist:songPositionsUpdated',
    // ---- 播放统计 ----
    'STATS.PLAYED_COUNT_UPDATED': 'stats:playedCountUpdated',
    // ---- 播放器事件 ----
    'PLAYER.SONG_STARTED': 'player:songStarted',
    'PLAYER.SONG_CHANGED': 'player:songChanged',
    'PLAYER.ERROR': 'player:error',
    // ---- 消息通知事件（主进程 -> 渲染进程）----
    'MESSAGE.INFO': 'message:info',
    'MESSAGE.SUCCESS': 'message:success',
    'MESSAGE.WARNING': 'message:warning',
    'MESSAGE.ERROR': 'message:error',
    // ---- 下载事件（主进程 -> 渲染进程）----
    'DOWNLOAD.STARTED': 'download:started',
    'DOWNLOAD.COMPLETED': 'download:completed',
    'DOWNLOAD.FAILED': 'download:failed',
    // 渲染进程 -> 渲染进程：有新的下载任务/记录被创建（含离线等导致的失败记录）后触发
    'DOWNLOAD.TASK_ADDED': 'download:taskAdded',
    // 主进程 -> 渲染进程：全部下载任务处理完毕（无 waiting/downloading/paused，仅 completed/failed）
    'DOWNLOAD.ALL_DONE': 'download:allDone',
    // ---- 跨渲染进程（主窗 <-> 歌词窗）播放同步 ----
    'PLAY.STATE': 'play:state',
    'PLAY.PROGRESS': 'play:progress',
    // ---- 主进程 -> 渲染进程 ----
    'APP.READY': 'app:ready',
    'TRAY.UPDATE': 'tray:update',
    // 桌面歌词窗开 / 关
    'DESKTOP_LYRIC.STATE': 'desktopLyricWindow:state',
    // 快捷键触发
    'HOTKEY_TRIGGERED': 'hotkeyTriggered',
    // ---- 自动更新（主进程 -> 渲染进程）----
    // 状态机快照：checking / available / downloaded / error 等低频变化
    'UPDATE.STATE': 'update:state',
    // 下载进度：高频（~4Hz），单独一条通道，避免拖动整棵关于页重渲染
    'UPDATE.PROGRESS': 'update:progress'
} as const

export type LpEvent = (typeof LP_EVENT)[keyof typeof LP_EVENT]
