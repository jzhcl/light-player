import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isOk } from '@shared/result'
import { formatDuration } from '@shared/format'
import { ListView, type ListMenuArg, type ListRowContext } from '@renderer/components/ListView'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { Icon } from '@renderer/components/Icon'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { useEvent } from '@renderer/hooks/useEvent'
import { useSongListPlayback, useSongListRemoval, useSongListSync } from '@renderer/hooks/useSongList'
import { usePlaylistStore } from '@renderer/store'
import { getPlaylistSongs } from '@renderer/features/playlist/playlistService'
import { unmarkSongLike } from '@renderer/features/song/songLike'
import { addSongsTo, applyToSongs, batchFeedback, toggleSongLike } from '@renderer/features/song/songActions'
import { message } from '@renderer/lib/message'
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
import { downloadSongs } from '@renderer/features/download/downloadService'
import { getSongsByIds } from '@renderer/lib/db'
import { LIKED_PLAYLIST_ID } from '@renderer/lib/constants'
import { LP_EVENT } from '@shared/event'

/**
 * 我喜欢（liked 歌单）页面
 */
export function LikedPage() {
    const [songs, setSongs] = useState<LP.Song[]>([])
    const [loading, setLoading] = useState(true)
    /** 取数失败 ≠ 列表为空：空态要能说清原因并给重试 */
    const [loadError, setLoadError] = useState(false)
    const [selection, setSelection] = useState<Set<string>>(new Set())
    const playlists = usePlaylistStore((s) => s.playlists)

    /**
     * 播放 / 菜单要读「最新列表」，但不能让列表身份进入行组件的 props：
     * 一旦 onPlay 的身份随列表变化，所有行的 memo 都会失效。
     */
    const songsRef = useRef(songs)
    songsRef.current = songs

    // 取数：liked 歌单的歌曲 id 顺序即列表顺序
    const load = useCallback(async () => {
        setLoading(true)
        const idsR = await getPlaylistSongs(LIKED_PLAYLIST_ID)
        if (!isOk(idsR)) {
            setLoadError(true)
            setLoading(false)
            return
        }
        const r = await getSongsByIds(idsR.value)
        if (!isOk(r)) {
            setLoadError(true)
            setLoading(false)
            return
        }
        setLoadError(false)
        setSongs(r.value)
        setLoading(false)
    }, [])

    useEffect(() => {
        void load()
    }, [load])

    // 列表一旦有内容（事件回流加进来的也算），之前的「加载失败」就不再成立
    useEffect(() => {
        if (songs.length > 0) setLoadError(false)
    }, [songs.length])

    // 新增一首
    const addSong = useCallback((song: LP.Song) => {
        setSongs((prev) => (prev.some((s) => s.id === song.id) ? prev : [song, ...prev]))
    }, [])

    const { removeSongs } = useSongListRemoval({ setSongs, setSelection })

    const fetchAndPrepend = useCallback(
        async (songId: string) => {
            const r = await getSongsByIds([songId])
            if (!isOk(r) || r.value.length === 0) return
            addSong(r.value[0])
        },
        [addSong],
    )

    /**
     * 跨页同步：改元数据 / 删歌 → `useSongListSync` 统一维护。
     * 本页是「成员资格就是 isLiked」的列表：喜欢 = 插入整行、取消 = 删除整行，
     * 与字段型列表（歌单 / 最近 / 本地）的打标语义不同，故这两条留在本页。
     */
    useSongListSync({ setSongs, removeSongs })
    useEvent(LP_EVENT['SONG.LIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        if (id) void fetchAndPrepend(id)
    })
    useEvent(LP_EVENT['SONG.UNLIKED'], (payload) => {
        const id = (payload as { id?: string } | undefined)?.id
        if (id) removeSongs([id])
    })

    const totalDuration = useMemo(
        () => songs.reduce((sum, s) => sum + (s.duration || 0), 0),
        [songs],
    )

    // 行的渲染身份统一用合成键（与搜索结果、队列里的插件项同一坐标系）；song.id 是存储身份，只用于读写库
    const getRowKey = useCallback((song: LP.Song) => songKey(song.pluginId, song.pluginSongId), [])
    const rowProps = useMemo(() => makeSongRowProps<LP.Song>((s) => `${s.name} - ${s.singer}`), [])
    // 本地文件已丢失 → 行灰化
    const rowClassName = useSongRowClassName()

    const handleSelectionChange = useCallback((keys: Set<string>) => setSelection(keys), [])

    const { playAll, playFromRow, activateRow } = useSongListPlayback({ listRef: songsRef, toEntry: toQueueRef })

    // 喜欢开关
    // 「已移除」这句只在成员型列表里需要 —— 用户看着那行消失，得解释一句
    const toggleLike = useCallback(async (song: LP.Song) => {
        await toggleSongLike(song)
    }, [])

    /**
     * 批量取消喜欢
     */
    const unlikeTargets = useCallback(async (targets: LP.Song[]) => {
        const { done, failed } = await applyToSongs(
            targets,
            (song) => unmarkSongLike(song.id),
            '取消喜欢',
        )
        if (done.length === 0 && failed === 0) return
        const fb = batchFeedback(done.length, failed, (n) =>
            n === 1 ? '已取消喜欢 1 首' : `已取消喜欢 ${n} 首`,
        )
        message[fb.type](fb.text)
    }, [])

    // 行内容
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
     * 右键菜单内容
     */
    const renderMenu = useCallback(
        ({ selection: sel }: ListMenuArg<LP.Song>): ReactNode => {
            const targets = sel.rows
            const entries = targets.map(toQueueRef)
            // 只要有一首带可下载音质就可用（过滤本地曲）
            const downloadable = targets.some((s) => s.pluginId !== 'local' && (s.supportQualities?.length ?? 0) > 0)
            // 单选且多音质 →「下载」展开音质子菜单
            const singleQuality = targets.length === 1 ? targets[0].supportQualities : undefined
            return (
                <>
                    <PlayItem entries={entries}/>
                    <AddToQueueItem entries={entries}/>
                    <ContextMenu.Separator/>
                    <AddToSubMenu
                        playlists={playlists}
                        includeLiked={false}
                        onPickPlaylist={(p) => void addSongsTo(targets, { kind: 'playlist', playlist: p })}
                    />
                    <DownloadItem disabled={!downloadable} qualityOptions={singleQuality} onSelect={(q) => void downloadSongs(targets, q)}/>
                    <ContextMenu.Separator/>
                    <ContextMenu.Item
                        icon="heart-break"
                        className="is-danger"
                        onSelect={() => void unlikeTargets(targets)}
                    >
                        取消喜欢
                    </ContextMenu.Item>
                </>
            )
        },
        [playlists, unlikeTargets],
    )

    const meta = loading
        ? ''
        : songs.length > 0
            ? `共 ${songs.length} 首${totalDuration > 0 ? ` · ${formatDuration(totalDuration)}` : ''}`
            : ''

    return (
        <div className="content-page">
            <div className="content-header">
                <div className="content-header-info">
                    <h1 className="content-title">我喜欢</h1>
                    <p className="content-meta">{meta}</p>
                </div>
                <div className="content-header-actions">
                    <button
                        className="content-play-btn"
                        type="button"
                        title="播放全部"
                        disabled={songs.length === 0}
                        onClick={playAll}
                    >
                        <Icon name="play" size={16}/>
                        <span>播放全部</span>
                    </button>
                </div>
            </div>

            <div className="content-list-wrap">
                {songs.length === 0 ? (
                    <div className="content-empty center">
                        <Icon name="heart" size={44} className="content-empty-icon"/>
                        <p className="content-empty-text">
                            {loading ? '加载中…' : loadError ? '喜欢列表加载失败' : '还没有喜欢的歌曲'}
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
                                点击歌曲旁的心形按钮收藏你喜欢的音乐
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
                                menuClassName="context-menu--liked"
                                progressive
                                renderRow={renderRow}
                            />
                        </ScrollArea>
                    </>
                )}
            </div>
        </div>
    )
}
