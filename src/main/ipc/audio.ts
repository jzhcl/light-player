import { ipcMain } from 'electron'
import { parseFile } from 'music-metadata'
import { join } from 'node:path'
import { fail, ok } from '@shared/result'
import type { AppContext } from '@main/app'
import { writeFile } from '@main/file'

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
}
