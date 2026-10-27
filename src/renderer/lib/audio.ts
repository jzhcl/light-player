import { invokeResult } from './ipc'
import { createFile } from './file'
import { generateId, join } from '@shared/utils'
import { useSettingsStore } from '@renderer/store'
import { toFileUrl } from './utils'


interface AudioPicture {
    /** 原始图片字节 */
    data: Uint8Array
    format: string
    type: string
}

/** music-metadata 的内嵌歌词标签（common.lyrics 的条目） */
interface AudioLyricTag {
    language?: string
    description?: string
    /** 纯文本歌词（未同步） */
    text?: string
    /** 已解析的同步歌词行；有值时 text 通常为空 */
    syncText?: unknown[]
}

interface AudioMetadata {
    common: Record<string, unknown> & {
        title?: string | null
        artists?: string[]
        album?: string | null
        picture?: AudioPicture[]
        /** 内嵌歌词（LRC 文本 / 同步歌词） */
        lyrics?: AudioLyricTag[]
    }
    format: Record<string, unknown> & {
        duration?: number
        bitrate?: number
        sampleRate?: number
        bitsPerSample?: number
        codec?: string
        container?: string
    }
}

/** 解析音频全量元数据 */
export async function parseAudioMetadata(filePath: string): Promise<Result<AudioMetadata>> {
    return invokeResult<AudioMetadata>('parseAudioMetadata', filePath)
}

/**
 * 用 HTMLAudioElement 二次解析音频时长。
 * 用于 music-metadata 取不到时长（0）或明显偏小的情况、
 * 容器头缺失、时长字段不可靠的格式。
 * 不抛异常：超时 / 加载失败 / 得到 NaN、Infinity、非正数一律返回 0，由调用方决定是否采用。
 * @param filePath 音频文件绝对路径（裸路径，内部转 file:// URL）
 * @returns 向下取整的秒数；取不到返回 0
 */
export function parseDurationWithAudio(filePath: string): Promise<number> {
    return new Promise(resolve => {
        const audio = new Audio()
        audio.preload = 'metadata'
        let timer: ReturnType<typeof setTimeout>

        /** 收尾：摘监听 + 断掉媒体加载 + 落定结果，保证只 resolve 一次 */
        const settle = (seconds: number) => {
            clearTimeout(timer)
            audio.removeEventListener('loadedmetadata', onLoadedMetadata)
            audio.removeEventListener('error', onError)
            audio.src = ''
            resolve(seconds)
        }

        const onLoadedMetadata = () => {
            const duration = audio.duration
            settle(Number.isFinite(duration) && duration > 0 ? Math.floor(duration) : 0)
        }
        const onError = () => settle(0)

        timer = setTimeout(() => settle(0), 5000)
        audio.addEventListener('loadedmetadata', onLoadedMetadata)
        audio.addEventListener('error', onError)
        audio.src = toFileUrl(filePath)
    })
}

function extFromFormat(format: string): string {
    const f = (format || '').toLowerCase()
    if (f.includes('jpeg') || f === 'jpg') return 'jpg'
    if (f.includes('png')) return 'png'
    if (f.includes('webp')) return 'webp'
    if (f.includes('gif')) return 'gif'
    if (f.includes('bmp')) return 'bmp'
    const m = f.match(/\.([a-z0-9]+)$/)
    return m ? m[1] : 'jpg'
}

/**
 * 将图片原始字节（Uint8Array）写入缓存目录 SongPic/，返回写入后的绝对路径。
 * 路径用 shared/join 拼接，避免 Windows 路径字符串格式问题。
 */
export async function cacheSongPicture(data: Uint8Array, format: string): Promise<string> {
    const dir = useSettingsStore.getState().settings['path.cacheDir']
    const ext = extFromFormat(format)
    const path = join(dir, 'SongPic', `${generateId('pic')}.${ext}`)
    await createFile(path, data)
    return path
}
