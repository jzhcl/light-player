import { isOk } from '@shared/result'
import { readFile } from '@renderer/lib/file'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'

/** MediaSession artwork 仅支持 http/https/data/blob 协议 */
const ALLOWED_ARTWORK_SCHEMES = /^(https?:|data:|blob:)/i

const ARTWORK_MIME_BY_EXT: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    bmp: 'image/bmp',
    gif: 'image/gif',
    svg: 'image/svg+xml',
    avif: 'image/avif',
}

/**
 * 将本地图片路径转为 data URL
 * @param path 本地图片的绝对路径
 * @returns data URL，读取失败时返回 undefined
 */
async function localPicToDataUrl(path: string): Promise<string | undefined> {
    try {
        const base64 = await readFile(path, 'base64')
        if (!isOk(base64)) {
            return undefined
        }
        if (!base64.value) return undefined
        const extMatch = path.match(/[^/\\]+\.([^./\\]+)$/)
        const ext = extMatch ? extMatch[1].toLowerCase() : ''
        const mime = ARTWORK_MIME_BY_EXT[ext] || 'image/jpeg'
        return `data:${mime};base64,${base64.value}`
    } catch {
        return undefined
    }
}

/**
 * 解析歌曲封面为 MediaSession 可用的 artwork
 * 优先使用在线地址；本地路径则读取文件转成 data URL；无法解析时省略 artwork
 * @param song 歌曲信息
 * @returns artwork 数组，封面不可用时返回 undefined
 */
async function resolveMediaSessionArtwork(song: LP.Song): Promise<MediaImage[] | undefined> {
    const url = song.pic?.url || ''
    const path = song.pic?.path || ''

    if (url && ALLOWED_ARTWORK_SCHEMES.test(url)) {
        return [{ src: url, sizes: '512x512' }]
    }
    if (path) {
        const dataUrl = await localPicToDataUrl(path)
        if (dataUrl) {
            return [{ src: dataUrl, sizes: '512x512' }]
        }
    }
    return undefined
}

/** 把当前曲写进系统媒体信息（Windows 走 SMTC，即任务栏/音量键弹层的媒体控件） */
async function updateSystemMetadata(song: LP.Song): Promise<void> {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.metadata = new MediaMetadata({
        title: song.name,
        artist: song.singer,
        album: song.album,
        artwork: await resolveMediaSessionArtwork(song),
    })
}

let unsubscribe: (() => void) | null = null

/**
 * 启动系统媒体信息同步：切歌时把当前曲写进 MediaSession metadata。
 * @returns 停止函数，供卸载时调用。
 */
export function initMediaSession(): () => void {
    if (unsubscribe) return () => {}

    unsubscribe = eventBus.on(LP_EVENT['PLAYER.SONG_CHANGED'], (...args) => {
        const song = args[0] as LP.Song | null | undefined
        // 无歌（如队列清空）不写
        if (!song?.name) return
        void updateSystemMetadata(song)
    })

    return () => {
        unsubscribe?.()
        unsubscribe = null
    }
}
