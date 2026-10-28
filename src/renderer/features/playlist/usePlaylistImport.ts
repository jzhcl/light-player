import { useCallback, useState, type DragEvent, type RefObject } from 'react'
import { isOk } from '@shared/result'
import { createSongFromLocalFile } from '@renderer/features/song/songIngest'
import { addSongToPlaylist } from './playlistService'
import { idList, rlog } from '@renderer/lib/log'
import { message } from '@renderer/lib/message'
import { importFeedback } from '@renderer/features/song/songActions'

/**
 * 从系统文件管理器拖入音频文件 → 解析元数据入库 → 挂进歌单。
 *
 * 列表不用手动插：`addSongToPlaylist` 会 emit `PLAYLIST.SONG_ADDED`，页面的订阅负责回流。
 *
 * 单文件与多文件的路径是分开的两段而不是「多文件循环的特例」，因为提示语义不同：
 * 单文件要能说清「哪个格式不支持 / 哪一步失败」，多文件只给一条汇总。
 */

/** 拖入导入允许的音频后缀 */
export const AUDIO_EXTENSIONS = ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma']

export interface PlaylistImportOptions {
    playlistId: string
    /** 判重用：已有的歌不重复加 */
    listRef: RefObject<readonly LP.Song[]>
    /** 批量导入后按 DB 的 position 序列收口（静默重取） */
    silentReload: () => void | Promise<void>
}

export interface PlaylistImport {
    /** 拖拽悬停高亮（容器加 `is-drop-active`） */
    dropActive: boolean
    handleDragOver: (e: DragEvent<HTMLDivElement>) => void
    handleDragLeave: (e: DragEvent<HTMLDivElement>) => void
    handleDrop: (e: DragEvent<HTMLDivElement>) => Promise<void>
}

/**
 * 取文件名那一段再取后缀：路径里可能有带点的目录名，直接对整条路径 `split('.')` 会串味。
 */
function extOf(path: string): { name: string; ext: string } {
    const name = path.split(/[\\/]/).pop() ?? path
    const dot = name.lastIndexOf('.')
    return { name, ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '' }
}

export function usePlaylistImport({
    playlistId,
    listRef,
    silentReload,
}: PlaylistImportOptions): PlaylistImport {
    const [dropActive, setDropActive] = useState(false)

    const handleDrop = useCallback(
        async (e: DragEvent<HTMLDivElement>) => {
            e.preventDefault()
            setDropActive(false)
            const files = Array.from(e.dataTransfer.files)
            if (files.length === 0) return

            /* ── 单文件：逐步骤给具体原因 ── */
            if (files.length === 1) {
                const path = window.api.getFilePath(files[0])
                const { ext } = extOf(path)
                if (!AUDIO_EXTENSIONS.includes(ext)) {
                    return
                }
                let song: LP.Song
                try {
                    const r = await createSongFromLocalFile(path)
                    if (!isOk(r)) {
                        return
                    }
                    song = r.value
                } catch (err) {
                    return
                }
                if (listRef.current.some((s) => s.id === song.id)) {
                    return
                }
                const linked = await addSongToPlaylist(playlistId, song.id)
                if (!isOk(linked)) {
                    return
                }
                return
            }

            /* ── 多文件：一条汇总 ── */
            const paths = files
                .map((f) => window.api.getFilePath(f))
                .filter((p) => AUDIO_EXTENSIONS.includes(extOf(p).ext))
            if (paths.length === 0) return

            const known = new Set(listRef.current.map((s) => s.id))
            let added = 0
            let dup = 0
            let failed = 0
            for (const path of paths) {
                try {
                    const r = await createSongFromLocalFile(path)
                    if (!isOk(r)) {
                        failed++
                        continue
                    }
                    const song = r.value
                    if (known.has(song.id)) {
                        dup++
                        continue
                    }
                    const linked = await addSongToPlaylist(playlistId, song.id)
                    if (!isOk(linked)) {
                        failed++
                        continue
                    }
                    known.add(song.id)
                    added++
                } catch {
                    // 单个文件解析 / 落盘异常不应中断整批导入
                    failed++
                }
            }

            // 以 DB 的 position 序列为准收口：批量「逐个插到最前」在 DB 里是逆序，
            // 静默按 DB 重排一次，避免本地回流顺序与 DB 漂移（否则切走再切回会变序）。
            if (added > 0) await silentReload()
            rlog.info(
                `[playlist] 导入到歌单 ${paths.length} 个：成功 ${added}，重复 ${dup}，失败 ${failed}` +
                    `\nplaylistId: ${playlistId}\npaths: ${idList(paths)}`,
            )
            const fb = importFeedback(added, dup, failed)
            message[fb.type](fb.text)



        },
        [playlistId, listRef, silentReload],
    )

    const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
        // 只接管「带着文件」的拖拽
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropActive(true)
    }, [])

    const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
        // 指针移进子元素同样会触发 leave，按 relatedTarget 是否仍在容器内过滤
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
        setDropActive(false)
    }, [])

    return { dropActive, handleDragOver, handleDragLeave, handleDrop }
}
