/**
 * 歌曲身份：合成键 + 队列项载体
 */
export const songKey = (pluginId: string, pluginSongId: string): string => {
    return `${pluginId ?? ''}:${pluginSongId ?? ''}`
}

/**
 * 队列项：
 * - 已落库歌曲 → 轻量身份载体 `LP.QueueRef`
 * - 尚未落库 → 原始插件歌曲对象，落库时才收敛为上面那种
 */
export type QueueEntry = LP.QueueRef | LP.Plugin.Song

/** LP.Song → 队列项（只保留身份三元组，丢掉 meta / quality 等展示数据） */
export const toQueueRef = (song: LP.Song): LP.QueueRef => ({
    id: song.id,
    pluginId: song.pluginId,
    pluginSongId: song.pluginSongId,
})

/**
 * 判定队列项是否为「已落库」形态
 */
export const isQueueRef = (entry: QueueEntry): entry is LP.QueueRef => {
    return typeof (entry as LP.QueueRef).pluginSongId === 'string'
}

/** 队列项唯一键：两种形态归一到同一坐标系（插件项以自身 id 作 pluginSongId） */
export const queueEntryKey = (entry: QueueEntry): string => {
    return isQueueRef(entry)
        ? songKey(entry.pluginId, entry.pluginSongId)
        : songKey(entry.pluginId, entry.id)
}
