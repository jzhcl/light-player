import { invokeResult } from './ipc'
import { toFileUrl } from './utils'


/** music-metadata 的内嵌歌词标签（common.lyrics 的条目） */
export interface AudioLyricTag {
    language?: string
    description?: string
    /** 歌词正文。文本本身是 LRC 时，时间轴会被解析进 `syncText` 并从 text 里剥掉 */
    text?: string
    /** 已解析出的同步歌词行（LRC 文本被解析后才有） */
    syncText?: { timestamp: number; text: string }[]
}

interface AudioMetadata {
    common: Record<string, unknown> & {
        title?: string | null
        artists?: string[]
        album?: string | null
        /** 内嵌图片数量 */
        pictureCount?: number
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
    return invokeResult<AudioMetadata>('audio:parseAudioMetadata', filePath)
}

/**
 * 抽取音频文件的内嵌封面[0]，写到 `destDir/<baseName>.<ext>`，返回实际写入的路径。
 *
 * `null` 表示文件没有内嵌图。
 */
export async function extractCoverTo(
    filePath: string,
    destDir: string,
    baseName: string,
): Promise<Result<string | null>> {
    return invokeResult<string | null>('audio:extractCover', filePath, destDir, baseName)
}

/** 写标签的入参：封面给在线地址，歌词给 LRC 文本（都可省略） */
export interface EmbedTagsInput {
    filePath: string
    coverUrl?: string
    lyric?: string
}

/** 实际写进去了什么；两项都 false = 文件里已有、或没提供，未落盘 */
export interface EmbedTagsResult {
    cover: boolean
    lyric: boolean
}

/**
 * 把封面与 LRC 写进音频文件（主进程用 taglib-wasm 实现）。
 *
 * 文件里已有封面 / 歌词时跳过该项，两样都不缺则完全不落盘。
 * 不支持的格式、文件被占用等会返回错误，调用方自行决定是否重试。
 */
export async function embedTags(input: EmbedTagsInput): Promise<Result<EmbedTagsResult>> {
    return invokeResult<EmbedTagsResult>('audio:embedTags', input)
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
