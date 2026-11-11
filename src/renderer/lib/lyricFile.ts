import { fail, isOk, ok } from '@shared/result'
import { join } from '@shared/utils'
import { deleteFile, ensureDir, isFileExists, readFile, writeFile } from './file'
import { QUALITY_SUFFIX_RE } from './fileNameFormat'
import { rlog } from './log'
import { useSettingsStore } from '@renderer/store'

/**
 * 下载歌曲的本地歌词文件。
 *
 * 目录固定为 `<userData>/download_lyric/`，不允许用户更改：它是「下载」这件事的产物 ——
 * 歌没下载就没有本地歌词，歌词也不该跟着下载目录一起漂移或被「清除缓存」扫掉。
 *
 * 文件名规则：音频文件名去掉扩展名、再剥掉音质后缀（`_H` / `_S` / `_R` / `_M`），
 * 加 `.json`。
 *
 * 读写都走主进程的 `file:*` IPC，这里只负责路径与内容形状。
 */

/** 歌词文件目录；`path.rootDir` 尚未初始化时返回空串 */
export function lyricDir(): string {
    const root = useSettingsStore.getState().settings['path.rootDir']
    return root ? join(root, 'download_lyric') : ''
}

/**
 * 音频路径 → 歌词文件路径。
 *
 * 从实际音频路径推导，而不是拿歌曲字段按当前文件名模板重算 ——
 * 后者在用户改过模板、或下载时是旧模板的情况下会对不上。
 */
export function lyricPathFor(audioPath: string): string {
    const dir = lyricDir()
    if (!dir || !audioPath) return ''
    // 兼容 `/` 与 `\`；再去扩展名（`a.b.mp3` → `a.b`）
    const name = (audioPath.split(/[\\/]/).pop() ?? '').replace(/\.[^.]+$/, '')
    return join(dir, `${name.replace(QUALITY_SUFFIX_RE, '')}.json`)
}

/**
 * 读歌词文件。没有文件、目录未就绪 → `ok(null)`；
 * JSON 坏掉或缺少必需的 `lyric` 字段 → 也当没有（记一条日志）。
 *
 * 只挑已知字段返回：文件是私有格式，将来手工改坏也不该把脏数据灌进库里。
 */
export async function readLyricFile(audioPath: string): Promise<Result<LP.LyricFile | null>> {
    const dest = lyricPathFor(audioPath)
    if (!dest) return ok(null)
    if (!(await isFileExists(dest))) return ok(null)

    const raw = await readFile(dest)
    if (!isOk(raw)) return raw

    let parsed: unknown
    try {
        parsed = JSON.parse(raw.value)
    } catch (err) {
        rlog.warn(`[lyric] 歌词文件解析失败 ${dest}：${(err as Error).message}`)
        return ok(null)
    }
    if (!parsed || typeof parsed !== 'object') return ok(null)

    const src = parsed as Record<string, unknown>
    if (typeof src.lyric !== 'string') return ok(null)

    const out: LP.LyricFile = {
        lyric: src.lyric,
        ...(typeof src.name === 'string' ? { name: src.name } : {}),
        ...(typeof src.singer === 'string' ? { singer: src.singer } : {}),
        ...(typeof src.album === 'string' ? { album: src.album } : {}),
        ...(typeof src.tlyric === 'string' ? { tlyric: src.tlyric } : {}),
        ...(Array.isArray(src.klyric) ? { klyric: src.klyric as LP.KrcLine[] } : {}),
        ...(typeof src.rlyric === 'string' || Array.isArray(src.rlyric)
            ? { rlyric: src.rlyric as string | LP.KrcLine[] }
            : {}),
    }
    return ok(out)
}

/** 写歌词文件（不缩进） */
export async function writeLyricFile(
    audioPath: string,
    payload: LP.LyricFile,
): Promise<Result<boolean>> {
    const dest = lyricPathFor(audioPath)
    if (!dest) return fail('用户目录未就绪，写不了歌词文件')

    const ready = await ensureDir(lyricDir())
    if (!isOk(ready)) return ready

    const r = await writeFile(dest, JSON.stringify(payload))
    if (isOk(r)) rlog.info(`[lyric] 已写入歌词文件 ${dest}`)
    return r
}

/** 删除歌词文件（不存在返回 false，不当作错误） */
export async function removeLyricFile(audioPath: string): Promise<Result<boolean>> {
    const dest = lyricPathFor(audioPath)
    if (!dest) return ok(false)
    if (!(await isFileExists(dest))) return ok(false)

    const r = await deleteFile(dest)
    if (isOk(r)) rlog.info(`[lyric] 已删除歌词文件 ${dest}`)
    return r
}

