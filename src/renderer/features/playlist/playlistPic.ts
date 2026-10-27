import { copyFile, deleteFile, ensureDir, listDir } from '@renderer/lib/file'
import { downloadImage, imageExtFromUrl } from '@renderer/lib/download'
import { getAllPlaylists } from '@renderer/lib/db'
import { useSettingsStore } from '@renderer/store'
import { generateId, join, normalizePath } from '@shared/utils'
import { isOk } from '@shared/result'


/**
 * 歌单封面统一落盘的目录：`<cacheDir>/PlaylistPic/`。
 *
 * 歌单封面永远持有一份自己的副本 —— 手动选图与程序自动挑图都先复制进这里，
 * 既不像歌曲封面那样按值引用缓存文件，也不长期指向用户选图时的原路径。
 *
 *  - 换封面留下的旧图不必立刻删，它会成为「未使用」的文件，由「清除缓存」
 *    统一回收。
 */
export function playlistPicDir(): string {
    const cacheDir = useSettingsStore.getState().settings['path.cacheDir']
    return cacheDir ? join(cacheDir, 'PlaylistPic') : ''
}

/** `path` 是否由我们托管（位于歌单图片目录内）。 */
export function isPlaylistPicPath(path?: string): boolean {
    const dir = playlistPicDir()
    return Boolean(dir && path && path.startsWith(`${dir}/`))
}

/** 从路径取扩展名（不含点），无扩展名回退 jpg。 */
function extOf(path: string): string {
    const m = path.match(/\.([^./\\]+)$/)
    return m ? m[1].toLowerCase() : 'jpg'
}

/**
 * 首个「有封面」歌曲的封面 —— 刻意跳过没图的歌，而不是取 `songs[0]`
 */
export function firstSongPic(list: LP.Song[]): LP.Song['pic'] | undefined {
    for (const s of list) {
        if (s.pic?.url || s.pic?.path) return s.pic
    }
    return undefined
}

/**
 * 把一张封面复制进歌单图片目录，返回可直接写库的 `{ url: '', path }`。
 *
 * 幂等：`pic.path` 已在目录内 → 原样返回，不重复复制。
 * 源既可以是用户手选的本地文件（只有 path），也可以是歌曲封面（可能只有 url）。
 * 复制与下载都不通 → 返回 undefined，调用方保持原封面不动。
 */
export async function ensurePlaylistPic(pic?: LP.Playlist['pic']): Promise<LP.Playlist['pic'] | undefined> {
    if (!pic?.url && !pic?.path) return undefined
    if (isPlaylistPicPath(pic.path)) return { url: '', path: pic.path }

    const dir = playlistPicDir()
    if (!dir) return undefined

    const ready = await ensureDir(dir)
    if (!isOk(ready)) return undefined

    if (pic.path) {
        const dest = join(dir, `${generateId('playlistPic')}.${extOf(pic.path)}`)
        const r = await copyFile(pic.path, dest)
        if (isOk(r)) return { url: '', path: dest }
    }
    if (pic.url) {
        const dest = join(dir, `${generateId('playlistPic')}.${imageExtFromUrl(pic.url)}`)
        const r = await downloadImage(pic.url, dest)
        if (isOk(r) && r.value) return { url: '', path: dest }
    }
    return undefined
}

/**
 * 清理歌单图片目录里未被任何歌单引用的文件。
 *
 * 判据 = 文件的归一化路径是否出现在某个歌单当前的 `pic.path` 里。所以歌单换了
 * 封面（pic1 → pic2）之后，pic1 落进未使用集合被回收、pic2 原样留着。
 */
export async function clearUnusedPlaylistPics(): Promise<{ deleted: number; failed: number }> {
    const out = { deleted: 0, failed: 0 }
    const dir = playlistPicDir()
    if (!dir) return out

    const list = await getAllPlaylists()
    if (!isOk(list)) return out
    const used = new Set<string>()
    for (const p of list.value) {
        const norm = normalizePath(p.pic?.path)
        if (norm) used.add(norm)
    }

    const entries = await listDir(dir)
    if (!isOk(entries)) return out
    for (const f of entries.value) {
        if (f.type !== 'file') continue
        if (used.has(normalizePath(f.path))) continue
        const del = await deleteFile(f.path)
        if (isOk(del)) out.deleted++
        else out.failed++
    }
    return out
}
