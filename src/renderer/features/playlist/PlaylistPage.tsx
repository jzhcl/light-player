import { isOk } from '@shared/result'
import {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { formatDuration } from '@shared/format'
import { ListView, type ListMenuArg, type ListRowContext } from '@renderer/components/ListView'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { Icon } from '@renderer/components/Icon'
import { Cover } from '@renderer/components/ui/Cover'
import { Modal } from '@renderer/components/ui/Modal'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { useEvent } from '@renderer/hooks/useEvent'
import { useSongListPlayback, useSongListRemoval, useSongListSync } from '@renderer/hooks/useSongList'
import { usePlaylistStore } from '@renderer/store'
import {
    ActionsColumn,
    AlbumColumn,
    Column,
    DurationColumn,
    IndexColumn,
    LikeButton,
    LocalBadge,
    PicColumn,
    PluginTag,
    QualityTag,
    makeSongRowProps,
    useSongRowClassName,
} from '@renderer/features/song/row'
import { songKey, toQueueRef } from '@renderer/features/song/songKey'
import { AddToSubMenu, AddToQueueItem, DownloadItem, PlayItem } from '@renderer/features/song/songMenu'
import { addSongsTo, applyToSongs, batchFeedback, toggleSongLike } from '@renderer/features/song/songActions'
import { message } from '@renderer/lib/message'
import { downloadSongs } from '@renderer/features/download/downloadService'
import { getPlaylistSongs, removeSongFromPlaylist, updatePlaylist } from '@renderer/features/playlist/playlistService'
import { ensurePlaylistPic, firstSongPic } from '@renderer/features/playlist/playlistPic'
import { usePlaylistReorder } from '@renderer/features/playlist/usePlaylistReorder'
import { DRAG_REORDER_MAX } from '@renderer/lib/constants'
import { usePlaylistAutoCover } from '@renderer/features/playlist/usePlaylistAutoCover'
import { usePlaylistImport } from '@renderer/features/playlist/usePlaylistImport'
import { getSongsByIds } from '@renderer/lib/db'
import { selectFile } from '@renderer/lib/file'
import { LP_EVENT } from '@shared/event'

/**
 * 用户歌单详情页（路由 `/playlist/:id`）。
 *
 * 守卫：歌单不在 store（深链进入、或已被删除）→ 重定向 /recent，与旧版
 * PlaylistPlaceholder 的行为一致。命中则用 `key={playlistId}` 重挂载详情，
 * 这样切换歌单时列表、选区、编辑态等本地状态一并重置，无需手写清理。
 */
export function PlaylistPage() {
    const { id } = useParams()
    const playlistId = id ?? ''
    const exists = usePlaylistStore((s) => s.playlists.some((p) => p.id === playlistId))
    if (!playlistId || !exists) return <Navigate to="/recent" replace/>
    return <PlaylistDetail key={playlistId} playlistId={playlistId}/>
}

/**
 * 歌单内容。数据源是 songs 表记录（LP.Song），因此播放队列用 id 字符串、
 * 行数据无需任何映射 —— 与「我喜欢」页同构，差别只在取数来源、菜单项与表头。
 */
function PlaylistDetail({ playlistId }: { playlistId: string }) {
    const playlist = usePlaylistStore((s) => s.playlists.find((p) => p.id === playlistId) ?? null)
    // 供「添加到」子菜单：排除当前歌单（自己加自己无意义）
    const playlists = usePlaylistStore((s) => s.playlists)

    const [songs, setSongs] = useState<LP.Song[]>([])
    const [loading, setLoading] = useState(true)
    /** 取数失败 ≠ 歌单为空：空态要能说清原因并给重试 */
    const [loadError, setLoadError] = useState(false)
    const [selection, setSelection] = useState<Set<string>>(new Set())

    /** 编辑弹窗的开关 */
    const [editing, setEditing] = useState(false)

    /**
     * 播放 / 菜单要读「最新列表」，但不能让列表身份进入行组件的 props：
     * 一旦 onPlay 的身份随列表变化，所有行的 memo 都会失效。
     */
    const songsRef = useRef(songs)
    songsRef.current = songs

    // 歌单封面的自动兜底
    const { pendingCover, sync: syncAutoCover } = usePlaylistAutoCover(playlistId)

    /**
     * 取数：playlist_songs 的 position 顺序即列表顺序。
     *
     * `silent`：静默重排 —— 不回填 loading、不动封面，只按 DB 真实序列对齐本地。
     */
    const loadSeqRef = useRef(0)
    const load = useCallback(async (opts?: { silent?: boolean }) => {
        const seq = ++loadSeqRef.current
        const silent = opts?.silent === true
        if (!silent) setLoading(true)
        const idsR = await getPlaylistSongs(playlistId)
        if (seq !== loadSeqRef.current) return
        if (!isOk(idsR)) {
            setLoadError(true)
            if (!silent) setLoading(false)
            return
        }
        const r = await getSongsByIds(idsR.value)
        if (seq !== loadSeqRef.current) return
        if (!isOk(r)) {
            setLoadError(true)
            if (!silent) setLoading(false)
            return
        }
        setLoadError(false)
        setSongs(r.value)
        if (!silent) {
            setLoading(false)
            // 列表到手后校准一次歌单封面
            syncAutoCover(firstSongPic(r.value))
        }
    }, [playlistId, syncAutoCover])

    useEffect(() => {
        void load()
    }, [load])

    // 列表一旦有内容（哪怕是事件回流加进来的），之前的「加载失败」就不再成立 ——
    // 否则「失败后加歌、再删空」会误显示错误态
    useEffect(() => {
        if (songs.length > 0) setLoadError(false)
    }, [songs.length])

    const { removeSongs } = useSongListRemoval({ setSongs, setSelection })

    /**
     * 跨页同步：改元数据 / 删歌 → `useSongListSync` 统一维护。
     * 喜欢状态在本页只是行里的一个字段 → 由 `patchRow` 就地打标。
     * 本页的「移除」只调服务层，状态更新统一由 PLAYLIST.SONG_REMOVED 驱动，避免双份逻辑。
     */
    const { patchRow } = useSongListSync({ setSongs, removeSongs })
    useEvent(LP_EVENT['SONG.LIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        if (id) patchRow(id, { isLiked: true })
    })
    useEvent(LP_EVENT['SONG.UNLIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        if (id) patchRow(id, { isLiked: false })
    })
    // 新歌回流：插到最前（DB 的 addSongToPlaylist 默认 position=0，新加的排在前）
    useEvent(LP_EVENT['PLAYLIST.SONG_ADDED'], (payload) => {
        const p = payload as { playlistId?: string; songId?: string }
        if (p?.playlistId !== playlistId || !p.songId) return
        const songId = p.songId
        void (async () => {
            const r = await getSongsByIds([songId])
            if (!isOk(r) || r.value.length === 0) return
            // 本地顺序必须跟 DB 一致：DB 插到 position 0，这里也插到最前（不能追加到末尾）
            setSongs((prev) => (prev.some((s) => s.id === songId) ? prev : [r.value[0], ...prev]))
            // 新歌可能就是这张歌单的第一张封面：本页加歌（拖入 / 右键添加）也要校准一次，
            // 否则封面只等到「下次进入页面」才生成，导航栏会一直是占位图
            syncAutoCover(r.value[0].pic)
        })()
    })
    useEvent(LP_EVENT['PLAYLIST.SONG_REMOVED'], (payload) => {
        const p = payload as { playlistId?: string; songId?: string }
        if (p?.playlistId !== playlistId || !p.songId) return
        removeSongs([p.songId])
    })

    const totalDuration = useMemo(
        () => songs.reduce((sum, s) => sum + (s.duration || 0), 0),
        [songs],
    )

    /**
     * 显示用封面：歌单自身的 pic 优先，其次才是校准窗口内的临时兜底。
     * 兜底只活一次校准的时间（`usePlaylistAutoCover` 保证），所以用户刚「移除封面」时这里
     * 拿到 undefined → 立刻显示占位图，不会被兜底顶回去。
     */
    const coverPic = useMemo(() => {
        const own = playlist?.pic
        if (own?.url || own?.path) return own
        return pendingCover
    }, [playlist?.pic, pendingCover])

    // 行的渲染身份统一用合成键（与搜索结果、队列里的插件项同一坐标系）；song.id 是存储身份，只用于读写库
    const getRowKey = useCallback((song: LP.Song) => songKey(song.pluginId, song.pluginSongId), [])
    const rowProps = useMemo(() => makeSongRowProps<LP.Song>((s) => `${s.name} - ${s.singer}`), [])
    // 本地文件已丢失 → 行灰化
    const rowClassName = useSongRowClassName()

    const handleSelectionChange = useCallback((keys: Set<string>) => setSelection(keys), [])

    const { playAll, playFromRow, activateRow } = useSongListPlayback({ listRef: songsRef, toEntry: toQueueRef })

    // 闸门在「歌曲列表加载完成」时按当时行数冻结一次（运行期不再翻，避免跨 500 换行组件类型）
    const { sortable, dragEnabled, moveSelection } = usePlaylistReorder({
        playlistId,
        listRef: songsRef,
        setSongs,
        reload: load,
        count: songs.length,
        loaded: !loading,
    })

    const silentReload = useCallback(() => load({ silent: true }), [load])

    const { dropActive, handleDragOver, handleDragLeave, handleDrop } = usePlaylistImport({
        playlistId,
        listRef: songsRef,
        silentReload,
    })

    // 喜欢开关：列表的 isLiked 变化由 SONG.LIKED / SONG.UNLIKED 订阅统一回写，此处只写库
    const toggleLike = useCallback((song: LP.Song) => void toggleSongLike(song), [])

    /**
     * 从本歌单移除
     */
    const removeTargets = useCallback(
        async (targets: LP.Song[]) => {
            const { done, failed } = await applyToSongs(
                targets,
                (song) => removeSongFromPlaylist(playlistId, song.id),
                '从歌单移除',
            )
            if (done.length === 0 && failed === 0) return
            const fb = batchFeedback(done.length, failed, (n) =>
                n === 1 ? '已从歌单移除 1 首' : `已从歌单移除 ${n} 首`,
            )
            message[fb.type](fb.text)
        },
        [playlistId],
    )

    // 行内容 = 若干列拼起来（行容器自带栅格，故此处直接返回列的 Fragment）
    const renderRow = useCallback(
        (song: LP.Song, ctx: ListRowContext) => (
            <>
                <IndexColumn
                    pluginId={song.pluginId}
                    pluginSongId={song.pluginSongId}
                    index={ctx.index}
                    onPlay={playFromRow}
                />
                <PicColumn pic={song.pic}/>
                <Column className="song-col--title">
                    <span className="song-title">
                        <span className="song-title-main">
                            <span className="song-name ellipsis">{song.name}</span>
                            <LocalBadge downloadQualities={song.downloadQualities}/>
                        </span>
                        {song.singer ? <span className="song-singer ellipsis">{song.singer}</span> : null}
                    </span>
                </Column>
                <ActionsColumn>
                    <LikeButton row={song} isLiked={song.isLiked} onToggle={toggleLike}/>
                    <PluginTag pluginId={song.pluginId}/>
                    <QualityTag quality={song.supportQualities}/>
                </ActionsColumn>
                <AlbumColumn album={song.album}/>
                <DurationColumn duration={song.duration}/>
            </>
        ),
        [playFromRow, toggleLike],
    )

    /**
     * 右键菜单内容（外部渲染，列表只管显隐与选区收敛）。
     * 收敛后的选区由 arg.selection 给出：右键行已在选区则作用于整个选区，否则仅该行。
     */
    const renderMenu = useCallback(
        ({ selection: sel }: ListMenuArg<LP.Song>): ReactNode => {
            const targets = sel.rows
            const entries = targets.map(toQueueRef)
            // 「添加到」排除本歌单（自己加自己无意义）
            const others = playlists.filter((p) => p.id !== playlistId)
            // 只要有一首带可下载音质就可用（本地曲没有音质信息）
            const downloadable = targets.some((s) => s.pluginId !== 'local' && (s.supportQualities?.length ?? 0) > 0)
            const singleQuality = targets.length === 1 ? targets[0].supportQualities : undefined
            return (
                <>
                    <PlayItem entries={entries}/>
                    <AddToQueueItem entries={entries}/>
                    <ContextMenu.Separator/>
                    <AddToSubMenu
                        playlists={others}
                        includeLiked
                        onPickLiked={() => void addSongsTo(targets, { kind: 'liked' })}
                        onPickPlaylist={(p) => void addSongsTo(targets, { kind: 'playlist', playlist: p })}
                    />
                    <DownloadItem disabled={!downloadable} qualityOptions={singleQuality} onSelect={(q) => void downloadSongs(targets, q)}/>
                    <ContextMenu.Separator/>
                    <ContextMenu.Sub label="调整" icon="arrow-down-up">
                        <ContextMenu.Item icon="arrow-up-short" onSelect={() => moveSelection(targets, 'up')}>
                            上移
                        </ContextMenu.Item>
                        <ContextMenu.Item
                            icon="arrow-down-short"
                            onSelect={() => moveSelection(targets, 'down')}
                        >
                            下移
                        </ContextMenu.Item>
                        <ContextMenu.Item
                            icon="arrow-bar-up"
                            onSelect={() => moveSelection(targets, 'top')}
                        >
                            移到顶部
                        </ContextMenu.Item>
                        <ContextMenu.Item
                            icon="arrow-bar-down"
                            onSelect={() => moveSelection(targets, 'end')}
                        >
                            移到末尾
                        </ContextMenu.Item>
                    </ContextMenu.Sub>
                    <ContextMenu.Separator/>
                    <ContextMenu.Item
                        icon="trash"
                        className="is-danger"
                        onSelect={() => void removeTargets(targets)}
                    >
                        从歌单中移除
                    </ContextMenu.Item>
                </>
            )
        },
        [playlists, playlistId, moveSelection, removeTargets],
    )

    // 歌单在视图存活期间被删除：外层守卫会接管重定向，这里只做渲染兜底
    if (!playlist) return null

    return (
        <div className="content-page">
            <div className="playlist-header">
                <div className="playlist-cover">
                    <Cover pic={coverPic} className="playlist-cover-img"/>
                </div>

                <div className="playlist-header-right">
                    <div className="playlist-header-info">
                        <div className="playlist-title-row">
                            <h1 className="content-title ellipsis" title={playlist.name}>
                                {playlist.name}
                            </h1>
                            <button
                                className="playlist-edit-btn"
                                type="button"
                                title="编辑信息"
                                onClick={() => setEditing(true)}
                            >
                                <Icon name="pencil" size={15}/>
                            </button>
                        </div>
                        {playlist.description ? (
                            <p className="playlist-desc ellipsis" title={playlist.description}>
                                {playlist.description}
                            </p>
                        ) : null}
                        <div className="playlist-meta">
                            {loading ? null : (
                                <>
                                    <span className="playlist-meta-item">
                                        <Icon name="music-note" size={14}/>
                                        {songs.length} 首歌曲
                                    </span>
                                    {totalDuration > 0 ? (
                                        <span className="playlist-meta-item">
                                            <Icon name="clock" size={14}/>
                                            {formatDuration(totalDuration)}
                                        </span>
                                    ) : null}
                                    {!dragEnabled ? (
                                        <span
                                            className="playlist-meta-item"
                                            title={`歌单超过 ${DRAG_REORDER_MAX} 首，已关闭拖拽排序；重新进入歌单会按最新歌曲数重新判定。调整顺序请用右键菜单的「上移 / 下移」`}
                                        >
                                            拖拽排序不可用 · 用右键菜单调整顺序
                                        </span>
                                    ) : null}
                                </>
                            )}
                        </div>
                    </div>

                    <div className="playlist-header-actions">
                        <button
                            className="content-play-btn"
                            type="button"
                            title="播放"
                            disabled={songs.length === 0}
                            onClick={playAll}
                        >
                            <Icon name="play" size={16}/>
                            <span>播放</span>
                        </button>
                    </div>
                </div>
            </div>

            <div
                className={`content-list-wrap${dropActive ? ' is-drop-active' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={(e) => void handleDrop(e)}
            >
                {songs.length === 0 ? (
                    <div className="content-empty center">
                        <Icon name="music-note-list" size={44} className="content-empty-icon"/>
                        <p className="content-empty-text">
                            {loading ? '加载中…' : loadError ? '歌单加载失败' : '歌单内还没有歌曲'}
                        </p>
                        {loading ? null : loadError ? (
                            <>
                                <p className="content-empty-hint">数据没有取回来，可以重试一次</p>
                                <button className="content-retry" type="button" onClick={() => void load()}>
                                    重试
                                </button>
                            </>
                        ) : (
                            <p className="content-empty-hint">
                                拖拽音频文件到此处，或在搜索结果里右键「添加到」本歌单
                            </p>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="song-head song-grid">
                            <Column className="song-col--index">#</Column>
                            <Column className="song-col--pic"/>
                            <Column className="song-col--title">歌曲</Column>
                            <Column className="song-col--actions"/>
                            <Column className="song-col--album">专辑</Column>
                            <Column className="song-col--duration">时长</Column>
                        </div>
                        <ScrollArea
                            className="song-scroll"
                            scrollClassName="song-scroll-view"
                            thumbClassName="song-scroll-thumb"
                            trigger="hover"
                            autoHide
                            deps={[songs]}
                        >
                            <ListView
                                className="song-rows"
                                items={songs}
                                getKey={getRowKey}
                                rowProps={rowProps}
                                rowClassName={rowClassName}
                                selectionMode="multi"
                                selection={selection}
                                onSelectionChange={handleSelectionChange}
                                onActivate={activateRow}
                                renderContextMenu={renderMenu}
                                menuClassName="context-menu--playlist"
                                // 单选拖拽重排（歌单过大时 sortable 为 undefined，改走右键菜单）
                                sortable={sortable}
                                // 上千首的歌单一次性挂载会卡首屏，交给渐进渲染分批发
                                progressive
                                renderRow={renderRow}
                            />
                        </ScrollArea>
                    </>
                )}
            </div>

            <PlaylistEditModal
                open={editing}
                onOpenChange={setEditing}
                playlistId={playlistId}
                playlist={playlist}
            />
        </div>
    )
}

// ─── 编辑信息弹窗 ───

const PLAYLIST_NAME_MAX = 20
const PLAYLIST_DESC_MAX = 200

const COVER_FILTERS = [
    { name: '图片文件', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] },
]

/**
 * 「无封面」的空 pic：保存时用它清空封面。
 *
 * 不等于「从未设置」：从未设置（`pic` 为 null）会在下一次校准窗口里被自动兜底填上，
 * 而这个空对象要等到再进一次页面才会被填。
 */
const EMPTY_PIC = { url: '', path: '' }

/**
 * 草稿形态。封面按 DB 的 { url, path } 双字段持有 —— 在线地址与本地路径不可混为一谈：
 * 早先把两者都收进单个 picPath 字符串，编辑一个只有在线封面的歌单会把地址
 * 落成 path 而经 toFileUrl 变成 file://https://…，封面直接失效。
 */
interface EditForm {
    name: string
    description: string
    pic: { url: string; path: string }
}

/** 由库里的歌单生成草稿 */
function toEditForm(playlist: LP.Playlist): EditForm {
    return {
        name: playlist.name,
        description: playlist.description ?? '',
        pic: { url: playlist.pic?.url ?? '', path: playlist.pic?.path ?? '' },
    }
}

interface PlaylistEditModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    playlistId: string
    /** 打开瞬间的取值来源 */
    playlist: LP.Playlist
}

/**
 * 编辑歌单信息（名称 / 描述 / 封面）。
 *
 * 草稿回填刻意走「open 翻转时渲染期同步赋值」而不是 `useEffect(..., [open, playlist])`：
 * 后者会在编辑途中被 store 更新打断 —— 例如自动封面 `syncAutoCover` 写库后
 * `playlist` 换了身份，正在输入的草稿会被整个重置。渲染期赋值同时保证不会
 * 先渲染一帧上一个歌单的旧值。
 */
function PlaylistEditModal({ open, onOpenChange, playlistId, playlist }: PlaylistEditModalProps) {
    const [form, setForm] = useState<EditForm>(() => toEditForm(playlist))
    const [saving, setSaving] = useState(false)

    const [wasOpen, setWasOpen] = useState(open)
    if (open !== wasOpen) {
        setWasOpen(open)
        if (open) {
            setForm(toEditForm(playlist))
            setSaving(false)
        }
    }

    const pickCover = useCallback(async () => {
        const path = await selectFile({ title: '选择封面图片', filters: COVER_FILTERS })
        // 手选了本地文件即整块替换封面（原先的在线地址一并丢弃，与「换一张图」的直觉一致）
        if (path) setForm((f) => ({ ...f, pic: { url: '', path } }))
    }, [])

    const saveEdit = useCallback(async () => {
        const name = form.name.trim()
        if (!name || saving) return
        setSaving(true)
        const owned = await ensurePlaylistPic(form.pic)
        const r = await updatePlaylist(playlistId, {
            name,
            description: form.description.trim(),
            pic: owned ?? { ...EMPTY_PIC },
        })
        setSaving(false)
        if (!isOk(r)) {
            message.error(`保存歌单信息失败：${r.error}`)
            return
        }
        message.success('歌单信息已更新')
        onOpenChange(false)
    }, [form, saving, playlistId, onOpenChange])

    const hasCover = Boolean(form.pic.url || form.pic.path)

    return (
        <Modal
            open={open}
            onOpenChange={onOpenChange}
            title="编辑歌单"
            className="playlist-edit-modal"
            contentStyle={{ width: 460 }}
        >
            <div className="playlist-edit-field">
                <label className="playlist-edit-label">歌单名称</label>
                <input
                    className="playlist-edit-input"
                    value={form.name}
                    maxLength={PLAYLIST_NAME_MAX}
                    placeholder="请输入歌单名称"
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            void saveEdit()
                        }
                    }}
                />
            </div>

            <div className="playlist-edit-field">
                <label className="playlist-edit-label">歌单描述</label>
                <textarea
                    className="playlist-edit-textarea"
                    value={form.description}
                    maxLength={PLAYLIST_DESC_MAX}
                    rows={3}
                    placeholder="请输入歌单描述（可选）"
                    onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
            </div>

            <div className="playlist-edit-field">
                <label className="playlist-edit-label">封面图片</label>
                <div className="playlist-edit-cover-row">
                    <button
                        className="playlist-edit-cover"
                        type="button"
                        title="选择图片"
                        onClick={() => void pickCover()}
                    >
                        {hasCover ? (
                            <Cover pic={form.pic} className="playlist-edit-cover-img"/>
                        ) : (
                            <>
                                <Icon name="add" size={20}/>
                                <span>点击选择图片</span>
                            </>
                        )}
                    </button>
                    {hasCover ? (
                        <button
                            className="playlist-edit-cover-remove"
                            type="button"
                            onClick={() => setForm((f) => ({ ...f, pic: { ...EMPTY_PIC } }))}
                        >
                            移除封面
                        </button>
                    ) : null}
                </div>
            </div>

            <div className="playlist-edit-footer">
                <button
                    className="playlist-edit-cancel"
                    type="button"
                    onClick={() => onOpenChange(false)}
                >
                    取消
                </button>
                <button
                    className="playlist-edit-save"
                    type="button"
                    disabled={!form.name.trim() || saving}
                    onClick={() => void saveEdit()}
                >
                    {saving ? '保存中…' : '保存'}
                </button>
            </div>
        </Modal>
    )
}
