/**
 * 跨渲染窗 topic 层
 */

export const TOPIC = {
    /** 主窗 */
    MAIN: 'mainWindow',
    /** 桌面歌词窗 */
    LYRIC: 'desktopLyricWindow',
    /** 托盘菜单窗 */
    TRAY_MENU: 'trayMenuWindow',
} as const

export type Topic = (typeof TOPIC)[keyof typeof TOPIC]

/**
 * topic → 该窗口允许接收的 channel
 */
export const TOPIC_CHANNELS = {
    [TOPIC.MAIN]: [
        // 歌词窗 / 托盘菜单窗 → 主窗：播放控制
        'control:playPause',
        'control:prev',
        'control:next',
        'control:toggleLike',
        'control:cyclePlayMode',
        'control:setVolume',
        'control:toggleDesktopLyricWindow',
        // 歌词窗 → 主窗：播放控制
        'control:closeDesktopLyricWindow',
        // 歌词窗 → 主窗：就绪握手（主窗收到后回灌首帧快照）
        'message:lyricReady',
    ],
    [TOPIC.LYRIC]: [
        // 主窗 → 歌词窗：歌词整包 / 播放态 / 进度
        'currentSongChanged',
        'currentPlayStateChanged',
        'currentPlayTimeUpdated',
        // 主窗 → 歌词窗：桌面歌词外观设置
        'desktopLyricSettingChanged',
    ],
    [TOPIC.TRAY_MENU]: [
        // 主进程 → 托盘菜单窗：菜单状态快照（曲目 / 播放态 / 喜欢 / 模式 / 音量 / 歌词）
        'trayMenuStateChanged',
    ],
} as const

/** topic 是否已登记 */
export function isKnownTopic(topic: string): topic is Topic {
    return Object.prototype.hasOwnProperty.call(TOPIC_CHANNELS, topic)
}

/** (topic, channel) 组合是否已登记 */
export function isAllowedChannel(topic: string, channel: string): boolean {
    if (!isKnownTopic(topic)) return false
    return (TOPIC_CHANNELS[topic] as readonly string[]).includes(channel)
}
