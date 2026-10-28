import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { isOk } from '@shared/result'
import { formatDuration, qualityLabel } from '@shared/format'
import { ListView, type ListMenuArg, type ListRowContext } from '@renderer/components/ListView'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { Icon } from '@renderer/components/Icon'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Modal } from '@renderer/components/ui/Modal'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { Popover } from '@renderer/components/ui/Popover'
import { useNavigateTo } from '@renderer/hooks/useNavigateTo'
import { useEvent } from '@renderer/hooks/useEvent'
import { useSongListPlayback, useSongListRemoval, useSongListSync } from '@renderer/hooks/useSongList'
import { usePlaylistStore } from '@renderer/store'
import { player } from '@renderer/features/player/player'
import { createSongFromLocalFile } from '@renderer/features/song/songIngest'
import { deleteSong } from '@renderer/features/song/songLifecycle'
import { updateSong } from '@renderer/features/song/songWrite'
import {
    ActionsColumn,
    AlbumColumn,
    Column,
    DurationColumn,
    IndexColumn,
    LikeButton,
    PicColumn,
    makeSongRowProps,
} from '@renderer/features/song/row'
import { songKey, toQueueRef } from '@renderer/features/song/songKey'
import { AddToSubMenu, AddToQueueItem } from '@renderer/features/song/songMenu'
import { addSongsTo, toggleSongLike } from '@renderer/features/song/songActions'
import { getLocalSongsAll } from '@renderer/lib/db'
import { getAllDownloadRecords, deleteDownloadRecordBySongAndQuality } from '@renderer/lib/db/downloadRecord'
import { deleteFile, isFileExists, selectFiles, showItemInFolder } from '@renderer/lib/file'
import { LP_EVENT } from '@shared/event'
import { DownloadRecordsTab } from './DownloadRecordsTab'
import { ScanDirectoryModal } from './ScanDirectoryModal'
import { normalizePath } from '@shared/utils'
import { clearFileMissing, markFileMissing, useMissingPaths } from '@renderer/lib/localFileCheck'
import { idList, rlog } from '@renderer/lib/log'
import { message } from '@renderer/lib/message'
import { batchFeedback, importFeedback } from '@renderer/features/song/songActions'

const AUDIO_FILTERS = [
    { name: '音频文件', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma'] },
]

type LocalTab = 'local' | 'downloaded' | 'records'

/**
 * 列表行 = 一个「落在磁盘上的文件」：本地原文件（pluginId='local'）与每首歌的每个已下载音质，
 * 都各占一行。这样「一首歌下载了多个音质」在下载歌曲 / 本地歌曲里自然展开成多行，
 * 删除语义也落到具体音质文件上（清 downloadQualities 对应项 + 删下载记录 + 可选删文件）。
 */
interface LocalSongFile {
    song: LP.Song
    quality: NonNullable<LP.Song['downloadQualities']>[number]
}

const fileKey = (f: LocalSongFile): string => `${songKey(f.song.pluginId, f.song.pluginSongId)}:${f.quality.type}`

/**
 * 本地与下载页（路由 `/local-download`），三个 Tab：
 *  - 本地歌曲：原本在本地 + LightPlayer 下载到本地的文件（超集）；删除=从 songs 表移除 + 可选删文件。
 *  - 下载歌曲：由 LightPlayer 下载到本地的文件（按音质展开）；删除=清该音质 + 删下载记录 + 可选删文件。
 *  - 下载记录：download_records 表全量记录（含历史）；自定义列表，批量开始/暂停/清除。
 */
export function LocalDownloadPage() {
    const [songs, setSongs] = useState<LP.Song[]>([])
    const [loading, setLoading] = useState(true)
    const [selection, setSelection] = useState<Set<string>>(new Set())
    const [adding, setAdding] = useState(false)
    const [recordCount, setRecordCount] = useState(0)
    const [scanOpen, setScanOpen] = useState(false)
    const [scanMenuOpen, setScanMenuOpen] = useState(false)
    // Tab 由 URL 查询参数驱动：?tab=local|downloaded|records，缺省 local。
    const [searchParams] = useSearchParams()
    const tabParam = searchParams.get('tab')
    const tab: LocalTab = tabParam === 'downloaded' || tabParam === 'records' ? tabParam : 'local'
    const playlists = usePlaylistStore((s) => s.playlists)

    // 获取下载记录条数
    const refetchRecordCount = useCallback(async () => {
        const r = await getAllDownloadRecords()
        if (isOk(r)) setRecordCount(r.value.length)
    }, [])
    // 进入页面即拉取一次，供【下载记录】Tab 显示个数（不必切过去才加载）
    useEffect(() => {
        void refetchRecordCount()
    }, [refetchRecordCount])
    useEvent(LP_EVENT['DOWNLOAD.TASK_ADDED'], refetchRecordCount)

    // 删除确认弹窗（勾选「同时删除本地文件」才碰磁盘）
    const [pendingDelete, setPendingDelete] = useState<LocalSongFile[] | null>(null)
    const [deleteFileToo, setDeleteFileToo] = useState(false)
    const [deleting, setDeleting] = useState(false)

    // 本地文件丢失（本机导入的歌曲）→ 询问是否从资料库移除
    const [pendingMissingSong, setPendingMissingSong] = useState<LP.Song | null>(null)
    const [missingBusy, setMissingBusy] = useState(false)

    // 已知缺失的路径集合 —— 行据此灰化
    const missingPaths = useMissingPaths()

    const songsRef = useRef(songs)
    songsRef.current = songs

    // 取数（过滤掉 download_qualities 解析后非数组/空的脏数据）
    const fetchLocalSongs = useCallback(async (): Promise<LP.Song[]> => {
        const r = await getLocalSongsAll()
        if (!isOk(r)) {
            return []
        }
        return r.value.filter(
            (s) => s.pluginId === 'local' || (Array.isArray(s.downloadQualities) && s.downloadQualities.length > 0),
        )
    }, [])

    const load = useCallback(async () => {
        setLoading(true)
        const all = await fetchLocalSongs()
        setSongs(all)
        setLoading(false)
    }, [fetchLocalSongs])

    useEffect(() => {
        void load()
    }, [load])

    // 下载完成刷新歌曲列表（不闪 loading）：新下载的插件歌曲此前不在 songs 中，
    // SONG.UPDATED 只会 patch 已有行、不会新增，故需整表重拉以更新【下载歌曲】与【本地歌曲】两个 Tab。
    const songRefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const refreshSongs = useCallback(async () => {
        const all = await fetchLocalSongs()
        setSongs(all)
    }, [fetchLocalSongs])
    const scheduleSongsRefetch = useCallback(() => {
        if (songRefetchTimer.current) clearTimeout(songRefetchTimer.current)
        songRefetchTimer.current = setTimeout(() => void refreshSongs(), 300)
    }, [refreshSongs])
    useEffect(
        () => () => {
            if (songRefetchTimer.current) clearTimeout(songRefetchTimer.current)
        },
        [],
    )
    // 下载完成即刷新两个文件型 Tab
    useEvent(LP_EVENT['DOWNLOAD.COMPLETED'], scheduleSongsRefetch)

    const { removeSongs } = useSongListRemoval({ setSongs, setSelection })

    // 跨页同步
    useEvent(LP_EVENT['SONG.CREATED'], (payload) => {
        const song = payload as LP.Song | undefined
        if (!song?.id) return
        const isLocal = song.pluginId === 'local' || (Array.isArray(song.downloadQualities) && song.downloadQualities.length > 0)
        if (!isLocal) return
        setSongs((prev) => (prev.some((s) => s.id === song.id) ? prev : [song, ...prev]))
    })
    // 改元数据 / 删歌 → `useSongListSync` 统一维护；喜欢在本页只是行里的一个字段 → 就地打标
    const { patchRow } = useSongListSync({ setSongs, removeSongs })
    useEvent(LP_EVENT['SONG.LIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        if (id) patchRow(id, { isLiked: true })
    })
    useEvent(LP_EVENT['SONG.UNLIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        if (id) patchRow(id, { isLiked: false })
    })

    // 下载歌曲（按音质展开成文件行）
    const downloadedSongs = useMemo<LP.Song[]>(
        () => songs.filter((s) => s.pluginId !== 'local' && Array.isArray(s.downloadQualities) && s.downloadQualities.length > 0),
        [songs],
    )

    // 文件行：本地歌曲 = 全部本地文件（已按路径去重，优先保留 pluginId='local' 的原文件，
    // 避免「同一文件既被下载、又被手动添加为本地文件」时出现重复行）；
    // 下载歌曲 = 已下载音质文件（不去重，保留下载语义）
    const localFiles = useMemo<LocalSongFile[]>(() => {
        // 路径归一
        const norm = (p?: string) => (p ? p.replace(/\\/g, '/').toLowerCase() : '')
        const seen = new Set<string>()
        const out: LocalSongFile[] = []
        const consider = (song: LP.Song, quality: NonNullable<LP.Song['downloadQualities']>[number]) => {
            const np = norm(quality.path)
            if (!np || seen.has(np)) return
            seen.add(np)
            out.push({ song, quality })
        }
        // 第一遍：本地原文件（pluginId='local'），其 downloadQualities[].path 即本地路径
        for (const s of songs) {
            if (s.pluginId !== 'local') continue
            for (const q of s.downloadQualities ?? []) consider(s, q)
        }
        // 第二遍：下载文件，跳过已出现过的路径（同一文件既下载又被手动添加为本地时去重）
        for (const s of songs) {
            if (s.pluginId === 'local') continue
            for (const q of s.downloadQualities ?? []) consider(s, q)
        }
        return out
    }, [songs])
    const downloadedFiles = useMemo<LocalSongFile[]>(
        () => downloadedSongs.flatMap((s) => (s.downloadQualities ?? []).map((q) => ({ song: s, quality: q }))),
        [downloadedSongs],
    )
    const currentFiles = tab === 'downloaded' ? downloadedFiles : localFiles

    // 播放去重：同一首歌多音质只占一个队列位
    const uniqueSongs = useMemo<LP.Song[]>(() => {
        const seen = new Set<string>()
        const out: LP.Song[] = []
        for (const f of currentFiles) {
            if (!seen.has(f.song.id)) {
                seen.add(f.song.id)
                out.push(f.song)
            }
        }
        return out
    }, [currentFiles])
    const fileSongPos = useMemo(() => {
        const m = new Map<string, number>()
        uniqueSongs.forEach((s, i) => m.set(s.id, i))
        return m
    }, [uniqueSongs])

    const currentFilesRef = useRef(currentFiles)
    currentFilesRef.current = currentFiles
    const uniqueSongsRef = useRef(uniqueSongs)
    uniqueSongsRef.current = uniqueSongs
    const fileSongPosRef = useRef(fileSongPos)
    fileSongPosRef.current = fileSongPos

    const getRowKey = useCallback((f: LocalSongFile) => fileKey(f), [])
    const rowProps = useMemo(() => makeSongRowProps<LocalSongFile>((f) => `${f.song.name} - ${f.song.singer}`), [])
    // 行容器类名：给「文件已丢失」的行挂 is-missing
    const rowClassName = useCallback(
        (f: LocalSongFile) => (missingPaths.has(normalizePath(f.quality.path)) ? 'is-missing' : ''),
        [missingPaths],
    )
    const handleSelectionChange = useCallback((keys: Set<string>) => setSelection(keys), [])

    const { playAll } = useSongListPlayback({ listRef: uniqueSongsRef, toEntry: toQueueRef })

    const playFileAt = useCallback(async (index: number) => {
        const files = currentFilesRef.current
        const file = files[index]
        const song = file?.song

        // 播放前校验：本地页的首选播放源就是本地文件，文件不在就没得播 —— 当场报告，
        // 不静默退回在线（那是「歌单等其他页面」的兜底语义，与本地页的意图相反）。
        if (file?.quality.path) {
            const exists = await isFileExists(file.quality.path)
            if (!exists) {
                markFileMissing(file.quality.path)

                if (song && song.pluginId === 'local') {
                    // 本机导入的歌曲：文件没了 = 这首歌彻底不可用，问用户是否从资料库移除。
                    // 取消也要留标记 —— 否则用户每次点到都会被再问一遍。
                    setPendingMissingSong(song)
                } else {
                    // 已下载的在线歌曲：本地副本没了，但在线还能播 —— 只提示，不删任何东西。
                }
                return
            }
            // 文件其实在（上次扫描后被放回 / 重新下载过）→ 清掉陈旧标记，让行立刻恢复。
            // 两类歌曲一视同仁：既然都探过磁盘了，留着旧标记只会让行说谎。
            clearFileMissing(file.quality.path)
        }

        const pos = song ? (fileSongPosRef.current.get(song.id) ?? index) : index
        // 队列去重 / 打乱都会移动下标 → 传源下标进去，它按那一项的唯一键在新队列里重新定位。
        player.setQueue(uniqueSongsRef.current.map(toQueueRef), pos)
        if (!song) return
        void player.playSong({ song, quality: file?.quality?.type })
    }, [])

    const handleActivate = useCallback((_f: LocalSongFile, index: number) => playFileAt(index), [playFileAt])

    const addSongs = useCallback(async () => {
        if (adding) return
        const paths = await selectFiles({ title: '选择音频文件', filters: AUDIO_FILTERS })
        if (paths.length === 0) return

        setAdding(true)
        const known = new Set(songsRef.current.map((s) => s.pluginSongId))
        let added = 0
        let failed = 0
        for (const path of paths) {
            try {
                const r = await createSongFromLocalFile(path)
                if (!isOk(r)) {
                    failed++
                    continue
                }
                if (!known.has(path)) {
                    known.add(path)
                    added++
                }
            } catch {
                failed++
            }
        }
        setAdding(false)

        const dup = paths.length - added - failed
        rlog.info(
            `[local] 添加本地文件 ${paths.length} 个：成功 ${added}，重复 ${dup}，失败 ${failed}` +
                `\npaths: ${idList(paths)}`,
        )
        const fb = importFeedback(added, dup, failed)
        message[fb.type](fb.text)
    }, [adding])

    const toggleLike = useCallback((song: LP.Song) => void toggleSongLike(song), [])


    const openDelete = useCallback((targets: LocalSongFile[]) => {
        setDeleteFileToo(false)
        setPendingDelete(targets)
    }, [])

    /**
     * 删除（按歌曲归组，避免同歌多音质逐条删时互相覆盖 downloadQualities）：
     *  - 本地原文件（pluginId='local'）：从 songs 表移除（可选删本地文件）。
     *  - 下载文件（pluginId!='local'）：只清该音质（过滤 downloadQualities 对应 path）+ 删下载记录
     *    （歌留在库；可选删本地文件）。
     */
    const confirmDelete = useCallback(async () => {
        const targets = pendingDelete
        if (!targets || deleting) return
        setDeleting(true)

        const bySong = new Map<string, { song: LP.Song; paths: Set<string>; qualities: Set<Quality> }>()
        for (const t of targets) {
            const g = bySong.get(t.song.id) ?? { song: t.song, paths: new Set<string>(), qualities: new Set<Quality>() }
            g.paths.add(t.quality.path)
            g.qualities.add(t.quality.type)
            bySong.set(t.song.id, g)
        }

        let count = 0
        let fileCount = 0
        for (const g of bySong.values()) {
            const song = g.song
            if (song.pluginId === 'local') {
                if (deleteFileToo) {
                    await deleteFile(song.pluginSongId)
                    fileCount++
                }
                if (await deleteSong(song.id)) count++
            } else {
                const cur = (song.downloadQualities ?? []).filter((q) => !g.paths.has(q.path))
                const upd = await updateSong(song.id, { downloadQualities: cur })
                if (!isOk(upd)) {
                    continue
                }
                for (const q of g.qualities) {
                    await deleteDownloadRecordBySongAndQuality(song.id, q)
                }
                if (deleteFileToo) {
                    for (const p of g.paths) {
                        await deleteFile(p)
                        fileCount++
                    }
                }
                count++
            }
        }

        // 清掉选择里已删除的文件行
        const deletedKeys = targets.map(fileKey)
        setSelection((prev) => {
            if (!deletedKeys.some((k) => prev.has(k))) return prev
            const next = new Set(prev)
            for (const k of deletedKeys) next.delete(k)
            return next
        })

        setDeleting(false)
        setPendingDelete(null)

        // 渲染端也记一笔：主进程只记「删了哪个文件」，看不出这是删歌动作的一部分
        rlog.info(
            `[local] 删除 ${count} 首` +
                (deleteFileToo ? `，同时删除本地文件 ${fileCount} 个` : '') +
                `\nsongIds: ${idList([...bySong.keys()])}`,
        )
        const total = bySong.size
        const fb = batchFeedback(count, total - count, (n) =>
            n === 1 ? '已删除 1 首' : `已删除 ${n} 首`,
        )
        message[fb.type](fb.text)

        void load()
        // 删除会移除下载记录（下载歌曲分支），刷新【下载记录】计数徽标
        void refetchRecordCount()
    }, [pendingDelete, deleting, deleteFileToo, refetchRecordCount])

    /**
     * 本地文件丢失 → 用户确认「从资料库移除这首歌」。
     * 走 deleteSong（级联清歌单引用 / 播放记录 / 下载记录 / 歌词），
     * 与「删除文件」不同：这里删的是整首歌，不留任何残留。
     */
    const confirmRemoveMissing = useCallback(async () => {
        const song = pendingMissingSong
        if (!song || missingBusy) return
        setMissingBusy(true)
        const done = await deleteSong(song.id)
        setMissingBusy(false)
        setPendingMissingSong(null)
        if (done) {
            // 歌已从资料库移除 → 它的文件路径不该再占着缺失记录（否则会一直占配额与复查名单）
            for (const q of song.downloadQualities ?? []) clearFileMissing(q.path)
            void load()
            void refetchRecordCount()
        } else {
        }
    }, [pendingMissingSong, missingBusy, refetchRecordCount])

    const renderRow = useCallback(
        (f: LocalSongFile, ctx: ListRowContext) => {
            const missing = missingPaths.has(normalizePath(f.quality.path))
            return (
            <>
                <IndexColumn pluginId={f.song.pluginId} pluginSongId={f.song.pluginSongId} index={ctx.index} onPlay={playFileAt} />
                <PicColumn pic={f.song.pic} />
                <Column className="song-col--title">
                    <span className="song-title">
                        <span className="song-title-main">
                            <span
                                className="song-name ellipsis"
                                title={missing ? `文件已丢失：${f.quality.path}` : undefined}
                            >
                                {f.song.name}
                            </span>
                        </span>
                        {f.song.singer ? <span className="song-singer ellipsis">{f.song.singer}</span> : null}
                    </span>
                </Column>
                <ActionsColumn>
                    <LikeButton row={f.song} isLiked={f.song.isLiked} onToggle={toggleLike} />
                    {missing ? <span className="song-tag song-tag--missing">文件丢失</span> : null}
                    <span className="song-tag song-tag--dl-quality">{qualityLabel(f.quality.type)}</span>
                    {f.quality.size ? <span className="song-tag song-tag--size">{f.quality.size}</span> : null}
                </ActionsColumn>
                <AlbumColumn album={f.song.album} />
                <DurationColumn duration={f.song.duration} />
            </>
            )
        },
        [playFileAt, toggleLike, missingPaths],
    )

    const renderMenu = useCallback(
        ({ item, selection: sel }: ListMenuArg<LocalSongFile>): ReactNode => {
            const targets = sel.rows
            const entries = targets.map((t) => toQueueRef(t.song))
            const first = targets[0]
            return (
                <>
                    <ContextMenu.Item
                        icon="play"
                        onSelect={() => {
                            const idx = currentFilesRef.current.indexOf(item)
                            if (idx >= 0) void playFileAt(idx)
                        }}
                    >
                        播放
                    </ContextMenu.Item>
                    <AddToQueueItem entries={entries} />
                    <ContextMenu.Separator />
                    <AddToSubMenu
                        playlists={playlists}
                        includeLiked
                        onPickLiked={() => void addSongsTo(targets.map((t) => t.song), { kind: 'liked' })}
                        onPickPlaylist={(p) => void addSongsTo(targets.map((t) => t.song), { kind: 'playlist', playlist: p })}
                    />
                    <ContextMenu.Separator />
                    <ContextMenu.Item
                        icon="folder"
                        onSelect={() => {
                            const f = first
                            if (f?.quality.path) void showItemInFolder(f.quality.path)
                        }}
                    >
                        打开文件位置
                    </ContextMenu.Item>
                    <ContextMenu.Separator />
                    <ContextMenu.Item icon="trash" className="is-danger" onSelect={() => openDelete(targets)}>
                        删除
                    </ContextMenu.Item>
                </>
            )
        },
        [playlists, openDelete, playFileAt],
    )

    // Tab 切换 = 导航（链接身份）：写入 ?tab= 查询参数，浏览器前进/后退与右键「打开」都按链接语义工作。
    // 进入【下载记录】即视为已查看下载结果；Tab 项展示实时记录数（recordCount，由 TASK_ADDED / 删除刷新）。
    const navigateTo = useNavigateTo()
    const goTab = useCallback(
        (t: LocalTab) => {
            if (t === tab) return
            navigateTo(`/local-download?tab=${t}`)
            setSelection(new Set())
            setPendingDelete(null)
        },
        [tab, navigateTo],
    )

    const totalDuration = useMemo(
        () => uniqueSongs.reduce((sum, s) => sum + (s.duration || 0), 0),
        [uniqueSongs],
    )

    const meta = loading
        ? ''
        : tab === 'records'
        ? recordCount > 0
            ? `共 ${recordCount} 条下载记录`
            : ''
        : currentFiles.length > 0
        ? `共 ${currentFiles.length} 个文件${totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : ''}`
        : ''

    return (
        <div className="content-page local-download">
            <div className="content-header">
                <div className="content-header-info">
                    <h1 className="content-title">本地与下载</h1>
                    <p className="content-meta">{meta}</p>
                </div>
                <div className="content-header-actions">
                    {tab === 'local' ? (
                        <div className="ld-add-split">
                            <button
                                className="content-add-btn ld-add-split__main"
                                type="button"
                                title="添加本地音频文件（可多选）"
                                disabled={adding}
                                onClick={() => void addSongs()}
                            >
                                <Icon name="add" size={16} />
                                <span>{adding ? '导入中…' : '添加'}</span>
                            </button>
                            <Popover
                                open={scanMenuOpen}
                                onOpenChange={setScanMenuOpen}
                                className="ld-add-popover popover--bare"
                                anchor={
                                    <button
                                        className="content-add-btn ld-add-split__caret"
                                        type="button"
                                        title="更多导入方式"
                                        aria-label="更多导入方式"
                                        aria-haspopup="menu"
                                        aria-expanded={scanMenuOpen}
                                        onClick={() => setScanMenuOpen((v) => !v)}
                                    >
                                        <Icon name="arrow-down-short" size={14} />
                                    </button>
                                }
                                side="bottom"
                                align="end"
                                sideOffset={6}
                                arrow={false}
                                autoFocus={false}
                            >
                                <button
                                    className="ld-add-menu-item"
                                    type="button"
                                    onClick={() => {
                                        setScanMenuOpen(false)
                                        setScanOpen(true)
                                    }}
                                >
                                    <Icon name="folder" size={16} />
                                    <span>扫描目录</span>
                                </button>
                            </Popover>
                        </div>
                    ) : null}
                    {tab !== 'records' ? (
                        <button
                            className="content-play-btn"
                            type="button"
                            title="播放全部"
                            disabled={currentFiles.length === 0}
                            onClick={playAll}
                        >
                            <Icon name="play" size={16} />
                            <span>播放全部</span>
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="ld-tabs">
                <a
                    className={`ld-tabs__item ${tab === 'local' ? 'ld-tabs__item--active' : ''}`}
                    href="#/local-download?tab=local"
                    onClick={(e) => {
                        e.preventDefault()
                        goTab('local')
                    }}
                >
                    <Icon name="music-note-list" size={16} />
                    <span>本地歌曲 {songs.length}</span>
                </a>
                <a
                    className={`ld-tabs__item ${tab === 'downloaded' ? 'ld-tabs__item--active' : ''}`}
                    href="#/local-download?tab=downloaded"
                    onClick={(e) => {
                        e.preventDefault()
                        goTab('downloaded')
                    }}
                >
                    <Icon name="download" size={16} />
                    <span>下载歌曲 {downloadedSongs.length}</span>
                </a>
                <a
                    className={`ld-tabs__item ${tab === 'records' ? 'ld-tabs__item--active' : ''}`}
                    href="#/local-download?tab=records"
                    onClick={(e) => {
                        e.preventDefault()
                        goTab('records')
                    }}
                >
                    <Icon name="arrow-down-short" size={16} />
                    <span>下载记录 {recordCount}</span>
                </a>
            </div>

            <div className="content-list-wrap">
                {tab === 'records' ? (
                    <DownloadRecordsTab onRecordsChanged={refetchRecordCount} />
                ) : currentFiles.length === 0 ? (
                    <div className="content-empty center">
                        <Icon name="music-note-list" size={44} className="content-empty-icon" />
                        <p className="content-empty-text">{loading ? '加载中…' : tab === 'downloaded' ? '还没有下载的歌曲' : '还没有本地歌曲'}</p>
                        {!loading ? (
                            <p className="content-empty-hint">
                                {tab === 'downloaded'
                                    ? '在歌曲上右键选择“下载”开始'
                                    : '点击右上角“添加”选择本机音频，或展开下拉选“扫描目录”批量导入'}
                            </p>
                        ) : null}
                    </div>
                ) : (
                    <>
                        <div className="song-head song-grid">
                            <Column className="song-col--index">#</Column>
                            <Column className="song-col--pic" />
                            <Column className="song-col--title">歌曲</Column>
                            <Column className="song-col--actions" />
                            <Column className="song-col--album">专辑</Column>
                            <Column className="song-col--duration">时长</Column>
                        </div>
                        <ScrollArea
                            className="song-scroll"
                            scrollClassName="song-scroll-view"
                            thumbClassName="song-scroll-thumb"
                            trigger="hover"
                            autoHide
                            deps={[currentFiles]}
                        >
                            <ListView
                                className="song-rows"
                                items={currentFiles}
                                getKey={getRowKey}
                                rowProps={rowProps}
                                selectionMode="multi"
                                selection={selection}
                                onSelectionChange={handleSelectionChange}
                                onActivate={handleActivate}
                                renderContextMenu={renderMenu}
                                menuClassName="context-menu--local-download"
                                rowClassName={rowClassName}
                                progressive
                                renderRow={renderRow}
                            />
                        </ScrollArea>
                    </>
                )}
            </div>

            <ScanDirectoryModal open={scanOpen} onOpenChange={setScanOpen} onImported={() => void load()} />

            <Modal
                open={pendingDelete !== null}
                onOpenChange={(open) => {
                    if (!open && !deleting) setPendingDelete(null)
                }}
                title="删除文件"
                className="local-download-del-modal"
                contentStyle={{ width: 420 }}
            >
                <p className="local-download-del-text">
                    {tab === 'downloaded'
                        ? `确定要移除选中的 ${pendingDelete?.length ?? 0} 个下载文件吗？歌曲仍保留在资料库中。`
                        : `确定要删除选中的 ${pendingDelete?.length ?? 0} 个文件吗？文件将从资料库中移除。`}
                </p>
                <div className="local-download-del-check">
                    <Checkbox
                        id="local-download-del-file"
                        checked={deleteFileToo}
                        onChange={setDeleteFileToo}
                        disabled={deleting}
                    />
                    <span
                        className="local-download-del-check-text"
                        onClick={() => {
                            if (!deleting) setDeleteFileToo((v) => !v)
                        }}
                    >
                        同时删除本地文件（删除后无法恢复）
                    </span>
                </div>
                <div className="local-download-del-footer">
                    <button className="local-download-del-cancel" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>
                        取消
                    </button>
                    <button className="local-download-del-danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>
                        {deleting ? '删除中…' : '删除'}
                    </button>
                </div>
            </Modal>

            {/* 本地文件丢失（本机导入的歌曲）：文件没了 = 这首歌彻底不可用，问用户是否移除。
                取消也保留 missing 标记（已在 playFileAt 里写入），避免每次点到都重复询问。 */}
            <Modal
                open={pendingMissingSong !== null}
                onOpenChange={(open) => {
                    if (!open && !missingBusy) setPendingMissingSong(null)
                }}
                title="本地文件已丢失"
                className="local-download-del-modal"
                contentStyle={{ width: 420 }}
            >
                <p className="local-download-del-text">
                    找不到《{pendingMissingSong?.name ?? ''}》的文件：
                    <br/>
                    <span className="local-download-missing-path">
                        {pendingMissingSong?.downloadQualities?.[0]?.path ??
                            pendingMissingSong?.pluginSongId ??
                            ''}
                    </span>
                    <br/>
                    是否从资料库中移除这首歌？它的歌单引用、播放记录、歌词等将一并清除。
                </p>
                <div className="local-download-del-footer">
                    <button
                        className="local-download-del-cancel"
                        type="button"
                        disabled={missingBusy}
                        onClick={() => setPendingMissingSong(null)}
                    >
                        取消
                    </button>
                    <button
                        className="local-download-del-danger"
                        type="button"
                        disabled={missingBusy}
                        onClick={() => void confirmRemoveMissing()}
                    >
                        {missingBusy ? '移除中…' : '移除'}
                    </button>
                </div>
            </Modal>
        </div>
    )
}
