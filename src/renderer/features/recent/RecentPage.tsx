import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isOk } from '@shared/result'
import { ListView, type ListMenuArg, type ListRowContext } from '@renderer/components/ListView'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { Icon } from '@renderer/components/Icon'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { useEvent } from '@renderer/hooks/useEvent'
import { useSongListPlayback, useSongListRemoval, useSongListSync } from '@renderer/hooks/useSongList'
import { usePlaylistStore, usePlayerStore } from '@renderer/store'
import {
    Column,
    DurationColumn,
    IndexColumn,
    PicColumn,
    AlbumColumn,
    makeSongRowProps,
    useSongRowClassName,
} from '@renderer/features/song/row'
import { songKey, toQueueRef } from '@renderer/features/song/songKey'
import { AddToSubMenu, AddToQueueItem, PlayItem } from '@renderer/features/song/songMenu'
import { addSongsTo, applyToSongs, batchFeedback } from '@renderer/features/song/songActions'
import { message } from '@renderer/lib/message'
import { deleteSongPlayedStats, getRecentPlayedSongs, getSongById, getSongPlayedStatsBySongId } from '@renderer/lib/db'
import { LP_EVENT } from '@shared/event'
import { formatDate, formatDuration } from '@shared/format'

/** 历史条目 = 歌曲 + 播放统计 */
type RecentSong = LP.Song & { playedCount: number; lastPlayedAt: string }

/** 单次取数上限 */
const RECENT_LIMIT = 500

/**
 * 「最近播放」页（路由 `/recent`，也是默认首页）。
 */
export function RecentPage() {
    const [songs, setSongs] = useState<RecentSong[]>([])
    const [loading, setLoading] = useState(true)
    /** 取数失败 ≠ 没有历史：空态要能说清原因并给重试 */
    const [loadError, setLoadError] = useState(false)
    const [selection, setSelection] = useState<Set<string>>(new Set())
    // 当前排序：仅「播放次数」「最近播放」两项可排，均支持升/降序；默认最近播放倒序
    const [sort, setSort] = useState<{ key: 'playedCount' | 'lastPlayedAt'; dir: 'asc' | 'desc' }>({
        key: 'lastPlayedAt',
        dir: 'desc',
    })
    const playlists = usePlaylistStore((s) => s.playlists)

    /**
     * 排序在已取回的 ≤500 条上做客户端排序（数据量小，不走 DB）
     */
    const sortedSongs = useMemo(() => {
        const arr = songs.slice()
        arr.sort((a, b) => {
            const cmp =
                sort.key === 'playedCount'
                    ? a.playedCount - b.playedCount
                    : new Date(a.lastPlayedAt).getTime() - new Date(b.lastPlayedAt).getTime()
            return sort.dir === 'asc' ? cmp : -cmp
        })
        return arr
    }, [songs, sort])

    /**
     * 播放 / 菜单要读「最新列表」，但不能让列表身份进入行组件的 props：
     * 一旦 onPlay 的身份随列表变化，所有行的 memo 都会失效。用排序后的列表作为播放顺序基准。
     */
    const songsRef = useRef(sortedSongs)
    songsRef.current = sortedSongs

    const toggleSort = (key: 'playedCount' | 'lastPlayedAt') =>
        setSort((prev) =>
            prev.key === key
                ? { key, dir: prev.dir === 'desc' ? 'asc' : 'desc' }
                : { key, dir: 'desc' },
        )

    /**
     * 取数。带代际守卫：并发来源是「挂载」与「每次起播补行」——
     * 没有守卫时，先发出、后返回的旧快照会覆盖期间刚补进来的行。
     */
    const loadSeqRef = useRef(0)
    const load = useCallback(async () => {
        const seq = ++loadSeqRef.current
        setLoading(true)
        const r = await getRecentPlayedSongs(RECENT_LIMIT)
        if (seq !== loadSeqRef.current) return
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

    // 列表一旦有内容（事件补进来的也算），之前的「加载失败」就不再成立
    useEffect(() => {
        if (songs.length > 0) setLoadError(false)
    }, [songs.length])

    const { removeSongs } = useSongListRemoval({ setSongs, setSelection })

    // 跨页同步：别处删歌 / 改元数据 → `useSongListSync` 统一维护
    useSongListSync({ setSongs, removeSongs })

    /**
     * 补一行「刚刚起播、但不在最近列表里」的歌（首次播放 / 超出 500 条上限）
     */
    const insertPlayedSong = useCallback(async (songId: string) => {
        const [songR, statR] = await Promise.all([
            getSongById(songId),
            getSongPlayedStatsBySongId(songId),
        ])
        if (!isOk(songR) || !songR.value) return
        if (!isOk(statR) || !statR.value) return
        const stat = statR.value
        const row: RecentSong = {
            ...songR.value,
            playedCount: stat.playedCount,
            lastPlayedAt: stat.lastPlayedAt || formatDate(),
        }
        setSongs((prev) => {
            if (prev.some((s) => s.id === songId)) return prev
            const next = [row, ...prev]
            if (next.length <= RECENT_LIMIT) return next
            // 超上限时丢「最近播放」最旧的那条 —— 数组顺序不等于时间顺序，不能在末尾盲切
            let oldest = 0
            for (let i = 1; i < next.length; i++) {
                if (new Date(next[i].lastPlayedAt).getTime() < new Date(next[oldest].lastPlayedAt).getTime()) {
                    oldest = i
                }
            }
            next.splice(oldest, 1)
            return next
        })
    }, [])

    /**
     * 播放次数更新：在列表内 → 只更该行（就地刷新次数与时间，位置交给客户端排序）；
     * 不在列表 → 只补这一行，不整表重取。
     */
    useEvent(LP_EVENT['STATS.PLAYED_COUNT_UPDATED'], (payload) => {
        const id = typeof payload === 'string' ? payload : undefined
        if (!id) return
        if (!songsRef.current.some((s) => s.id === id)) {
            void insertPlayedSong(id)
            return
        }
        setSongs((prev) => {
            const idx = prev.findIndex((s) => s.id === id)
            if (idx === -1) return prev
            const hit = prev[idx]
            const updated: RecentSong = {
                ...hit,
                playedCount: hit.playedCount + 1,
                lastPlayedAt: formatDate(),
            }
            return [updated, ...prev.slice(0, idx), ...prev.slice(idx + 1)]
        })
    })

    const totalCount = songs.length
    const totalDuration = songs.reduce((s, song) => s + (song.duration || 0), 0)

    // 行的渲染身份统一用合成键
    const getRowKey = useCallback((song: RecentSong) => songKey(song.pluginId, song.pluginSongId), [])
    // 需要带上 song-grid--recent：本页是 7 列，缺了它行会退回共用 6 列、与表头错位
    const rowProps = useMemo(
        () => makeSongRowProps<RecentSong>((s) => `${s.name} - ${s.singer}`, 'song-grid--recent'),
        [],
    )
    // 本地文件已丢失 → 行灰化
    const rowClassName = useSongRowClassName()
    const handleSelectionChange = useCallback((keys: Set<string>) => setSelection(keys), [])

    const { playAll, playFromRow, activateRow } = useSongListPlayback({ listRef: songsRef, toEntry: toQueueRef })

    /**
     * 从历史中删除：只清 song_played_stats。
     * 正在播放的那首不删。
     */
    const removeHistory = useCallback(async (targets: RecentSong[]) => {
        const current = usePlayerStore.getState().currentSong
        const rest = targets.filter((s) => s.id !== current?.id)
        if (rest.length === 0) {
            return
        }

        const { done: ids, failed } = await applyToSongs(
            rest,
            (song) => deleteSongPlayedStats(song.id),
            '删除播放历史',
        )
        if (ids.length > 0) removeSongs(ids)
        if (ids.length > 0 || failed > 0) {
            const fb = batchFeedback(ids.length, failed, (n) =>
                n === 1 ? '已删除 1 条播放记录' : `已删除 ${n} 条播放记录`,
            )
            message[fb.type](fb.text)
        }
    }, [removeSongs])

    // 行内容
    const renderRow = useCallback(
        (song: RecentSong, ctx: ListRowContext) => (
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
                        </span>
                        {song.singer ? <span className="song-singer ellipsis">{song.singer}</span> : null}
                    </span>
                </Column>
                <AlbumColumn album={song.album}/>
                <Column className="song-col--played">
                    <span className="song-played-count">{song.playedCount} 次</span>
                </Column>
                <Column className="song-col--last-played">
                    <span className="song-last-played">{formatLastPlayed(song.lastPlayedAt)}</span>
                </Column>
                <DurationColumn duration={song.duration}/>
            </>
        ),
        [playFromRow],
    )

    /**
     * 右键菜单内容
     */
    const renderMenu = useCallback(
        ({ selection: sel }: ListMenuArg<RecentSong>): ReactNode => {
            const targets = sel.rows
            const entries = targets.map(toQueueRef)
            return (
                <>
                    <PlayItem entries={entries}/>
                    <AddToQueueItem entries={entries}/>
                    <ContextMenu.Separator/>
                    <AddToSubMenu
                        playlists={playlists}
                        includeLiked
                        onPickLiked={() => void addSongsTo(targets, { kind: 'liked' })}
                        onPickPlaylist={(p) => void addSongsTo(targets, { kind: 'playlist', playlist: p })}
                    />
                    <ContextMenu.Separator/>
                    <ContextMenu.Item
                        icon="trash"
                        className="is-danger"
                        onSelect={() => void removeHistory(targets)}
                    >
                        从历史中删除
                    </ContextMenu.Item>
                </>
            )
        },
        [playlists, removeHistory],
    )

    const meta = loading
        ? ''
        : totalCount > 0
            ? `共 ${totalCount} 首 · 总时长 ${formatDuration(totalDuration)}`
            : ''

    return (
        <div className="content-page">
            <div className="content-header">
                <div className="content-header-info">
                    <h1 className="content-title">最近播放</h1>
                    <p className="content-meta">{meta}</p>
                </div>
                <div className="content-header-actions">
                    <button
                        className="content-play-btn"
                        type="button"
                        title="播放全部"
                        disabled={totalCount === 0}
                        onClick={playAll}
                    >
                        <Icon name="play" size={16}/>
                        <span>播放全部</span>
                    </button>
                </div>
            </div>

            <div className="content-list-wrap">
                {totalCount === 0 ? (
                    <div className="content-empty center">
                        <Icon name="clock-history" size={44} className="content-empty-icon"/>
                        <p className="content-empty-text">
                            {loading ? '加载中…' : loadError ? '播放历史加载失败' : '暂无播放历史'}
                        </p>
                        {loading ? null : loadError ? (
                            <>
                                <p className="content-empty-hint">数据没有取回来，可以重试一次</p>
                                <button className="content-retry" type="button" onClick={() => void load()}>
                                    重试
                                </button>
                            </>
                        ) : (
                            <p className="content-empty-hint">播放的歌曲会出现在这里</p>
                        )}
                    </div>
                ) : (
                    <>
                        <div className="song-head song-grid song-grid--recent">
                            <Column className="song-col--index">#</Column>
                            <Column className="song-col--pic"/>
                            <Column className="song-col--title">歌曲</Column>
                            <Column className="song-col--album">专辑</Column>
                            <Column
                                className="song-col--played is-sortable"
                                onClick={() => toggleSort('playedCount')}
                            >
                                播放次数
                                {sort.key === 'playedCount' && (
                                    <Icon
                                        name={sort.dir === 'asc' ? 'arrow-up-short' : 'arrow-down-short'}
                                        size={14}
                                        className="sort-indicator"
                                    />
                                )}
                            </Column>
                            <Column
                                className="song-col--last-played is-sortable"
                                onClick={() => toggleSort('lastPlayedAt')}
                            >
                                最近播放
                                {sort.key === 'lastPlayedAt' && (
                                    <Icon
                                        name={sort.dir === 'asc' ? 'arrow-up-short' : 'arrow-down-short'}
                                        size={14}
                                        className="sort-indicator"
                                    />
                                )}
                            </Column>
                            <Column className="song-col--duration">时长</Column>
                        </div>
                        <ScrollArea
                            className="song-scroll"
                            scrollClassName="song-scroll-view"
                            thumbClassName="song-scroll-thumb"
                            trigger="hover"
                            autoHide
                            deps={[sortedSongs]}
                        >
                            <ListView
                                className="song-rows"
                                items={sortedSongs}
                                getKey={getRowKey}
                                rowProps={rowProps}
                                rowClassName={rowClassName}
                                selectionMode="multi"
                                selection={selection}
                                onSelectionChange={handleSelectionChange}
                                onActivate={activateRow}
                                renderContextMenu={renderMenu}
                                menuClassName="context-menu--recent"
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

/**
 * 最近播放时间 → 相对时间描述。
 * 刚刚 / N 分钟前 / N 小时前 / N 天前（< 7 天）/ MM-DD（今年）/ YYYY-MM-DD。
 */
function formatLastPlayed(dateStr: string): string {
    if (!dateStr) return ''
    const date = new Date(dateStr)
    if (Number.isNaN(date.getTime())) return ''

    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return '刚刚'
    if (diffMin < 60) return `${diffMin} 分钟前`
    const diffHour = Math.floor(diffMin / 60)
    if (diffHour < 24) return `${diffHour} 小时前`
    const diffDay = Math.floor(diffHour / 24)
    if (diffDay < 7) return `${diffDay} 天前`

    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return date.getFullYear() === now.getFullYear()
        ? `${m}-${d}`
        : `${date.getFullYear()}-${m}-${d}`
}
