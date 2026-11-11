import { ipcMain } from 'electron'
import { parseFile } from 'music-metadata'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TagLib } from 'taglib-wasm'
import { fail, ok } from '@shared/result'
import type { AppContext } from '@main/app'
import { writeFile } from '@main/file'
import { log } from '@main/log'

/**
 * 内嵌封面格式（MIME）→ 扩展名。
 * 认不出来按 jpg 落：music-metadata 对缺 format 的 APIC 帧可能给空串，jpg 是最常见的兜底。
 */
function extFromFormat(format?: string): string {
    const f = (format || '').toLowerCase()
    if (f.includes('jpeg') || f === 'jpg') return 'jpg'
    if (f.includes('png')) return 'png'
    if (f.includes('webp')) return 'webp'
    if (f.includes('gif')) return 'gif'
    if (f.includes('bmp')) return 'bmp'
    const m = f.match(/\.([a-z0-9]+)$/)
    return m ? m[1] : 'jpg'
}

/** 封面文件扩展名 → MIME（写入侧兜底用；认不出来就不写封面） */
const COVER_MIME: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
}

/**
 * 抓封面字节并定 MIME：以响应头为准，CDN 回 `application/octet-stream` 时退回 URL 后缀。
 *
 * 取不到（网络失败 / 不是图片）返回 null。
 */
async function fetchCover(url: string): Promise<{ mimeType: string; data: Uint8Array } | null> {
    try {
        const res = await fetch(url)
        if (!res.ok) {
            log.warn(`[embed] 封面下载失败 HTTP ${res.status}：${url}`)
            return null
        }
        const header = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
        const fromExt = (url.match(/(\.[a-z0-9]+)(?:[?#]|$)/i)?.[1] ?? '').toLowerCase()
        const mimeType = header.startsWith('image/') ? header : COVER_MIME[fromExt]
        if (!mimeType) {
            log.warn(`[embed] 封面不是图片（content-type=${header || '空'}）：${url}`)
            return null
        }
        return { mimeType, data: new Uint8Array(await res.arrayBuffer()) }
    } catch (err) {
        log.warn(`[embed] 封面下载异常：${url}\n${(err as Error).message}`)
        return null
    }
}

/**
 * 把音频文件的内嵌封面[0]写到 `destDir/<baseName>.<ext>`，返回实际写入的路径。
 * 扩展名来自图片格式。
 *
 * 文件没有内嵌图 → 返回 null；
 * 解析或写入出错 → throw。
 */
async function extractCoverTo(
    filePath: string,
    destDir: string,
    baseName: string,
): Promise<string | null> {
    const meta = await parseFile(filePath)
    const picture = meta.common.picture?.[0]
    if (!picture) return null
    const dest = join(destDir, `${baseName}.${extFromFormat(picture.format)}`)
    writeFile(dest, picture.data)
    return dest
}

// ============================================================
// 内嵌写入（taglib-wasm）：封面 + LRC 歌词
// ============================================================

type TagLibInstance = Awaited<ReturnType<typeof TagLib.initialize>>

const wasmPath = (): string => fileURLToPath(new URL('./taglib-wasi.wasm', import.meta.url))

let taglib: Promise<TagLibInstance> | null = null

/** 惰性初始化：首次真正要写标签才加载 wasm */
function getTagLib(): Promise<TagLibInstance> {
    taglib ??= TagLib.initialize({ wasmUrl: wasmPath() }).catch((err: unknown) => {
        // 初始化失败不缓存，下次调用重试
        taglib = null
        throw err
    })
    return taglib
}

export interface EmbedTagsInput {
    /** 目标音频文件绝对路径 */
    filePath: string
    /** 封面图片的在线地址；省略 = 不写封面 */
    coverUrl?: string
    /** LRC 文本；省略或空白 = 不写歌词 */
    lyric?: string
}

/** 实际写进去了什么。两项都 false = 文件里已有、或没提供对应数据，没有落盘 */
export interface EmbedTagsResult {
    cover: boolean
    lyric: boolean
}

/**
 * 把封面与 LRC 写进音频文件（容器格式由 taglib 自行识别）。
 *
 * 文件里已有任意封面 / 任意歌词时不动它 —— 只在确实缺失时才写。
 *
 * 出错：格式不支持、文件被占用、图片读不出都会抛。
 */
async function embedTags(input: EmbedTagsInput): Promise<EmbedTagsResult> {
    const { filePath, coverUrl, lyric } = input
    const file = await (await getTagLib()).open(filePath)
    try {
        const wrote: EmbedTagsResult = { cover: false, lyric: false }

        if (coverUrl && file.getPictures().length === 0) {
            const cover = await fetchCover(coverUrl)
            if (cover) {
                file.setPictures([
                    { type: 'FrontCover', mimeType: cover.mimeType, data: cover.data, description: '' },
                ])
                wrote.cover = true
            }
        }

        const text = lyric?.trim()
        if (text && file.getLyrics().length === 0) {
            // language 用 und（undetermined）：歌曲语言未知，别猜成 chi
            file.setLyrics([{ text, language: 'und', description: '' }])
            wrote.lyric = true
        }

        if (!wrote.cover && !wrote.lyric) return wrote

        await file.saveToFile()
        return wrote
    } finally {
        file.dispose()
    }
}

export function registerAudioHandlers(_ctx: AppContext): void {
    ipcMain.handle('audio:parseAudioMetadata', async (_e, filePath: string) => {
        try {
            const meta = await parseFile(filePath)
            // 不传图片数据
            const { picture, ...rest } = meta.common
            const common: Record<string, unknown> = {
                ...rest,
                pictureCount: Array.isArray(picture) ? picture.length : 0,
            }
            return ok({ common, format: { ...meta.format } })
        } catch (err) {
            return fail((err as Error).message)
        }
    })

    ipcMain.handle(
        'audio:extractCover',
        async (_e, filePath: string, destDir: string, baseName: string) => {
            try {
                return ok(await extractCoverTo(filePath, destDir, baseName))
            } catch (err) {
                return fail((err as Error).message)
            }
        },
    )

    ipcMain.handle('audio:embedTags', async (_e, input: EmbedTagsInput) => {
        try {
            return ok(await embedTags(input))
        } catch (err) {
            return fail((err as Error).message)
        }
    })
}
