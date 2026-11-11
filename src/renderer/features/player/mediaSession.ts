import { isOk } from '@shared/result'
import { readFile } from '@renderer/lib/file'
import { fromFileUrl } from '@renderer/lib/utils'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { player } from '@renderer/features/player/player'
import { usePlayerStore } from '@renderer/store'

/**
 * 系统媒体信息（macOS 控制中心「正在播放」/ Windows 任务栏媒体控件）。
 *
 * 这里有三个和时序有关的坑，改动前先读完：
 *
 * 1. 起播时必须再推一次 metadata。切歌时写 metadata 只是写进 Blink；系统面板真正取值
 *    是在「有媒体开始播放、媒体会话被激活」那一刻。先写再起播的时序里，Electron 在 macOS
 *    上只把播放态与时长交给了系统，标题/歌手/封面全丢（表现为控制中心只显示 App 名）。
 *    所以 SONG_STARTED 时重推一版 —— 此刻会话刚激活，系统会照着这份更新。
 *
 * 2. 封面不能挡在文字前面。解析封面要读盘（本地曲）或走网络（插件曲），是异步的；
 *    等它回来可能已经错过第 1 条那个时机。先写文字，封面回来再补一版（带缓存，重推时直接复用）。
 *
 * 3. playbackState 必须显式设置。它默认是 'none'，系统据此渲染播放/暂停按钮；
 *    不设的话面板上的按钮状态与真实播放态脱节。
 */

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
 */
async function resolveArtwork(song: LP.Song): Promise<MediaImage[] | undefined> {
    const pic = song.pic ?? ''
    if (!pic) return undefined

    if (ALLOWED_ARTWORK_SCHEMES.test(pic)) {
        return [{ src: pic, sizes: '512x512' }]
    }
    // 本地歌抽出来的内嵌图是 file://，系统面板不认这个协议 → 转成 data URL 再给
    const path = fromFileUrl(pic)
    if (!path) return undefined
    const dataUrl = await localPicToDataUrl(path)
    return dataUrl ? [{ src: dataUrl, sizes: '512x512' }] : undefined
}

/** 封面缓存：重推 metadata 时不能每次都去读盘 */
let artworkCache: { key: string; artwork: MediaImage[] | undefined } | null = null

/** 曲目身份：插件曲与本地曲都有 id，缺 id 时退化为「歌名-歌手」 */
function songKey(song: LP.Song): string {
    return song.id || `${song.name}-${song.singer}`
}

/** 写一版 metadata */
function pushMetadata(song: LP.Song, artwork?: MediaImage[]): void {
    if (!('mediaSession' in navigator)) return
    try {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: song.name || '',
            artist: song.singer || '',
            album: song.album || '',
            artwork,
        })
    } catch {
        // 个别字段非法（如空 artwork 项）会让整次赋值抛错，吞掉不影响播放
    }
}

/** 切歌：先写文字，封面异步补一版 */
function onSongChanged(raw: unknown): void {
    const song = raw as LP.Song | null | undefined
    if (!song?.name) return

    const key = songKey(song)
    const cached = artworkCache?.key === key ? artworkCache.artwork : undefined
    pushMetadata(song, cached)
    if (cached) return

    void (async () => {
        const artwork = await resolveArtwork(song)
        // 期间又切歌了：这份封面已经过时，别覆盖新曲的信息
        const current = usePlayerStore.getState().currentSong
        if (!current || songKey(current) !== key) return
        // 解析失败不入缓存：否则这首歌永远不会再尝试解析封面
        if (!artwork) return
        artworkCache = { key, artwork }
        pushMetadata(song, artwork)
    })()
}

/**
 * 起播：媒体会话此刻才被激活，把 metadata 重推一版。
 * 封面已在缓存里就直接带上，避免第一帧没封面。
 */
function onSongStarted(): void {
    const song = usePlayerStore.getState().currentSong
    if (!song) return
    pushMetadata(song, artworkCache?.key === songKey(song) ? artworkCache.artwork : undefined)
}

/** 播放态同步给系统面板 */
function syncPlaybackState(state: PlayState): void {
    if (!('mediaSession' in navigator)) return
    navigator.mediaSession.playbackState =
        state === 'playing' ? 'playing' : state === 'paused' ? 'paused' : 'none'
}

/** 系统面板上的传输键 */
function installActionHandlers(): void {
    const ms = navigator.mediaSession
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null): void => {
        try {
            ms.setActionHandler(action, handler)
        } catch {
            // 个别动作在部分平台不支持，注册失败不影响其余
        }
    }

    set('play', () => void player.play())
    set('pause', () => player.pause())
    set('stop', () => player.stop())
    set('previoustrack', () => void player.playPrev())
    set('nexttrack', () => void player.playNext())
    set('seekto', (details) => {
        if (typeof details.seekTime === 'number') player.seekTo(details.seekTime)
    })
}

/** 取消订阅们的句柄 */
let disposers: Array<() => void> | null = null

/**
 * 启动系统媒体信息同步。
 * @returns 停止函数，供卸载时调用
 */
export function initMediaSession(): () => void {
    if (disposers) return () => {}
    if (!('mediaSession' in navigator)) return () => {}

    installActionHandlers()
    // 首帧就要正确：会话可能是在「恢复上次歌曲」之后才建立的
    syncPlaybackState(usePlayerStore.getState().state)

    const offChanged = eventBus.on(LP_EVENT['PLAYER.SONG_CHANGED'], onSongChanged)
    const offStarted = eventBus.on(LP_EVENT['PLAYER.SONG_STARTED'], onSongStarted)
    const offStore = usePlayerStore.subscribe((state, prev) => {
        if (state.state !== prev.state) syncPlaybackState(state.state)
    })

    // 启动恢复的那次 SONG_CHANGED 发在本模块订阅之前（恢复在渲染前初始化、本模块在
    // App 的 useEffect 里），监听器会扑空 —— 封面解析与缓存从此无人建立，起播时
    // SONG_STARTED 只能推纯文字版 metadata。这里补放一次当前曲。
    const restored = usePlayerStore.getState().currentSong
    if (restored?.name) onSongChanged(restored)

    disposers = [
        offChanged,
        offStarted,
        offStore,
        () => {
            artworkCache = null
        },
    ]

    return () => {
        for (const off of disposers ?? []) off()
        disposers = null
    }
}
