import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isOk } from '@shared/result'
import { useSearchParams } from 'react-router-dom'
import { ListView, type ListMenuArg, type ListRowContext } from '@renderer/components/ListView'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { Icon } from '@renderer/components/Icon'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { useInView } from '@renderer/hooks/useInView'
import { useNavigateTo } from '@renderer/hooks/useNavigateTo'
import { useSongListPlayback } from '@renderer/hooks/useSongList'
import { useStableRows } from '@renderer/hooks/useStableRows'
import { usePluginStore, usePlaylistStore } from '@renderer/store'
import { songKey, type QueueEntry } from '@renderer/features/song/songKey'
import { AddToSubMenu, AddToQueueItem, DownloadItem, PlayItem } from '@renderer/features/song/songMenu'
import { downloadSongs } from '@renderer/features/download/downloadService'
import { ensureSong } from '@renderer/features/song/songIngest'
import {
    ActionsColumn,
    AlbumColumn,
    Column,
    DurationColumn,
    IndexColumn,
    LikeButton,
    PicColumn,
    PluginTag,
    QualityTag,
    makeSongRowProps,
} from '@renderer/features/song/row'
import { addSongsTo, toggleSongLike, type AddTarget } from '@renderer/features/song/songActions'
import { SEARCH_PAGE_SIZE, searchSongsByPlugin } from './searchService'
import { useExistingBackfill } from './useExistingBackfill'

/**
 * 搜索结果筛选项：
 * - 0 个插件支持 search → 提示「请先安装或启用支持在线搜索的插件」，不发起搜索；
 * - 仅 1 个插件支持 → 不显示 Tab 栏（综合结果即该插件结果）；
 * - ≥2 个插件支持 → 显示 Tab 栏，首项「综合」，其余各插件，默认在「综合」。
 *
 * 缓存与翻页模型（减少无意义搜索）：
 *   以「综合」页的页码为全局基准游标（combinedPageRef）。每一页结果按 (插件, 页号) 缓存：
 *   - 综合加载第 N 页：写入 cache['all'][N] 与 cache[每个插件][N]（综合已含各插件第 N 页）。
 *   - 切到具体插件：显示窗退回到基准页码（只展示综合已缓存的 1..combinedPage 过滤结果），零请求；
 *     继续翻页才对该插件单独发请求（searchSongsByPlugin(pluginId)），写入 cache[插件][N]。
 *   - 切回综合：显示窗回到基准页码，呈现已缓存的综合结果；继续翻页推进综合第 N 页。
 *   - 从具体插件切到另一插件 / 切回综合再切回：仍以综合基准页码为准（已走过更深的页仍缓存，但显示回退到基准）。
 *   即：每个插件的每一页都缓存（组件内，切走再切回即丢），已请求过的页不再发请求。
 */
const EMPTY_PLUGINS: string[] = []

interface PageResult {
    songs: LP.Plugin.Song[]
    total: number
    isEnd: boolean
}

interface SearchRow {
    song: LP.Plugin.Song
    /** songs 表 id（该曲已入库时才有） */
    id?: string
    isLiked: boolean
}

/** 搜索结果本身就是队列项（`LP.Plugin.Song` 是 `QueueEntry` 的一支），无需转换 */
const asQueueEntry = (song: LP.Plugin.Song): QueueEntry => song

export function SearchPage() {
    const [searchParams] = useSearchParams()
    const q = searchParams.get('q') ?? ''
    const kw = q.trim()
    const navigateTo = useNavigateTo()

    // 支持 search 命令的插件 id
    const rawSearchIds = usePluginStore((s) => s.commandMap['search'])
    const searchPluginIds = rawSearchIds ?? EMPTY_PLUGINS
    const plugins = usePluginStore((s) => s.plugins)
    const playlists = usePlaylistStore((s) => s.playlists)

    const [songs, setSongs] = useState<LP.Plugin.Song[]>([])
    const [total, setTotal] = useState(0)
    const [isEnd, setIsEnd] = useState(false)
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    /** 最近一次请求里失败的插件数（空态里用来区分「插件挂了」与「真的没结果」） */
    const [failedPlugins, setFailedPlugins] = useState(0)
    /** 翻页没有进展：本页 0 首且插件仍称「还有更多」⇒ 页脚给重试，而不是静默停住 */
    const [stalled, setStalled] = useState(false)
    const [selection, setSelection] = useState<Set<string>>(new Set())
    // 当前激活 Tab：'all' = 综合；其余为具体插件 id
    const [activeTab, setActiveTab] = useState<'all' | string>('all')

    // ---- 缓存与分页游标（组件内，切走即丢）----
    // cache[插件|'all'][页号] = 该页结果
    const cacheRef = useRef<Map<string, Map<number, PageResult>>>(new Map())
    // 全局基准页码：仅综合加载推进
    const combinedPageRef = useRef(0)
    // 各 Tab 是否已到末页
    const tabEndRef = useRef<Map<string, boolean>>(new Map())
    // 各 Tab 的 total
    const tabTotalRef = useRef<Map<string, number>>(new Map())
    // 当前 Tab 可见窗口末尾页（逻辑值）
    const displayPageRef = useRef(0)

    const activeTabRef = useRef<'all' | string>('all')
    activeTabRef.current = activeTab
    const songsRef = useRef(songs)
    songsRef.current = songs

    const reqRef = useRef(0)
    // 请求在途守卫：触底事件高频触发，避免同一页被重复请求
    const inFlightRef = useRef(false)
    // 同「关键词|插件集合」只发起一次首屏搜索
    const lastKeyRef = useRef<string | null>(null)
    // 懒加载哨兵：放在列表尾部，由 IntersectionObserver 观察
    const sentinelRef = useRef<HTMLDivElement>(null)

    const showTabs = searchPluginIds.length >= 2
    const hasSearchPlugins = searchPluginIds.length > 0

    const pluginNameMap = useMemo(() => {
        const m = new Map<string, string>()
        for (const p of plugins) m.set(p.id, p.name)
        return m
    }, [plugins])

    const tabs = useMemo(() => {
        const arr: { value: string; label: string }[] = [{ value: 'all', label: '综合' }]
        for (const pid of searchPluginIds) arr.push({ value: pid, label: pluginNameMap.get(pid) ?? pid })
        return arr
    }, [searchPluginIds, pluginNameMap])

    // 激活 Tab 若指向已不可用的插件（被禁用/移除）→ 回落到综合
    useEffect(() => {
        if (activeTab !== 'all' && !searchPluginIds.includes(activeTab)) setActiveTab('all')
    }, [searchPluginIds, activeTab])

    /** 由缓存重建当前 Tab 的可见列表（按 displayPage 取 1..displayPage 页） */
    const rebuild = useCallback(() => {
        const tab = activeTabRef.current
        const upto = displayPageRef.current
        const cache = cacheRef.current
        const result: LP.Plugin.Song[] = []
        const seen = new Set<string>()
        for (let p = 1; p <= upto; p++) {
            let pageSongs: LP.Plugin.Song[] | undefined
            if (tab !== 'all') {
                const own = cache.get(tab)?.get(p)
                if (own) pageSongs = own.songs
            }
            if (!pageSongs) {
                const cPage = cache.get('all')?.get(p)
                if (cPage) pageSongs = tab === 'all' ? cPage.songs : cPage.songs.filter((s) => s.pluginId === tab)
            }
            if (!pageSongs) continue
            for (const s of pageSongs) {
                const k = songKey(s.pluginId ?? '', s.id)
                if (seen.has(k)) continue
                seen.add(k)
                result.push(s)
            }
        }
        setSongs(result)
        setTotal(tabTotalRef.current.get(tab) ?? 0)
        setIsEnd(tabEndRef.current.get(tab) ?? false)
    }, [])

    /** 加载某 Tab 的指定页并写入缓存，然后重建可见列表 */
    const runSearch = useCallback(
        async (tab: 'all' | string, keyword: string, page: number) => {
            if (inFlightRef.current) return
            inFlightRef.current = true
            const seq = ++reqRef.current
            if (page === 1) setLoading(true)
            else setLoadingMore(true)
            try {
                const r = await (tab === 'all'
                    ? searchSongsByPlugin(keyword, page, SEARCH_PAGE_SIZE)
                    : searchSongsByPlugin(keyword, page, SEARCH_PAGE_SIZE, tab))
                if (seq !== reqRef.current) return // 已被更新的请求覆盖
                setFailedPlugins(r.failed)
                // 翻页没有进展：本页 0 首、插件仍称未到底 ⇒ 页脚改为「重试」。
                // 首页 0 首归空态管，不设 stalled。
                setStalled(page > 1 && r.songs.length === 0 && !r.isEnd)

                const pageResult: PageResult = { songs: r.songs, total: r.total, isEnd: r.isEnd }
                if (!cacheRef.current.has(tab)) cacheRef.current.set(tab, new Map())
                cacheRef.current.get(tab)!.set(page, pageResult)

                if (tab === 'all') {
                    combinedPageRef.current = page
                    // 综合结果按插件拆分写入各自缓存，省去后续过滤
                    const byPlugin = new Map<string, LP.Plugin.Song[]>()
                    for (const s of r.songs) {
                        const pid = s.pluginId ?? ''
                        const arr = byPlugin.get(pid) ?? []
                        arr.push(s)
                        byPlugin.set(pid, arr)
                    }
                    for (const [pid, list] of byPlugin) {
                        if (!cacheRef.current.has(pid)) cacheRef.current.set(pid, new Map())
                        cacheRef.current.get(pid)!.set(page, { songs: list, total: r.total, isEnd: r.isEnd })
                    }
                }

                tabTotalRef.current.set(tab, r.total)
                tabEndRef.current.set(tab, r.isEnd)

                // 显示窗：综合与基准同步；具体插件推进到刚加载的页
                displayPageRef.current = tab === 'all' ? page : Math.max(displayPageRef.current, page)
                rebuild()
            } finally {
                if (seq === reqRef.current) {
                    inFlightRef.current = false
                    setLoading(false)
                    setLoadingMore(false)
                }
            }
        },
        [rebuild],
    )

    /** 触底：下一页若已缓存则仅揭示，否则发请求 */
    const loadMore = useCallback(() => {
        if (!kw || !hasSearchPlugins || isEnd || loading) return
        const tab = activeTabRef.current
        const next = displayPageRef.current + 1
        const cache = cacheRef.current
        const cached =
            tab === 'all'
                ? !!cache.get('all')?.has(next)
                : !!cache.get(tab)?.has(next) ||
                  (next <= combinedPageRef.current && !!cache.get('all')?.has(next))
        if (cached) {
            displayPageRef.current = next
            rebuild()
            return
        }
        void runSearch(tab, kw, next)
    }, [kw, hasSearchPlugins, isEnd, loading, runSearch, rebuild])

    // 底部外扩 100px 提前触发。
    // `reobserveOn: songs.length` 是「续拉不依赖用户滚动」的关键：IntersectionObserver
    // 只在相交状态变化时上报；一页加载完若哨兵仍在视口内（内容不足一屏 / 插件单页返回很少），
    // 不重建 observer 就永远等不到下一次事件 ⇒ 加载静默停摆。重建会立即上报当前相交状态。
    useInView(sentinelRef, loadMore, {
        rootMargin: '0px 0px 100px 0px',
        disabled: isEnd || loading,
        reobserveOn: songs.length,
    })

    /** 清空缓存、游标与列表状态 */
    const resetAll = useCallback(() => {
        cacheRef.current = new Map()
        combinedPageRef.current = 0
        tabEndRef.current = new Map()
        tabTotalRef.current = new Map()
        displayPageRef.current = 0
        setSongs([])
        setTotal(0)
        setIsEnd(false)
        setStalled(false)
        setSelection(new Set())
        setLoading(false)
        setLoadingMore(false)
        inFlightRef.current = false // 允许新搜索立即覆盖在途请求
    }, [])

    // query 或可用插件集合变化：重置缓存并发起综合首屏搜索
    useEffect(() => {
        if (!kw || !hasSearchPlugins) {
            resetAll()
            // 空关键词也要复位去重键：否则「清空 → 再搜同一个词」会被 lastKeyRef 挡住
            lastKeyRef.current = null
            return
        }
        // 同「关键词|插件集合」不重复发起
        const key = `${kw}|${searchPluginIds.join(',')}`
        if (lastKeyRef.current === key) return
        lastKeyRef.current = key

        resetAll()
        void runSearch('all', kw, 1)
    }, [kw, runSearch, hasSearchPlugins, searchPluginIds, resetAll])

    /** 首屏失败后重试：复位去重键与缓存，按当前 Tab 重发首屏 */
    const retrySearch = useCallback(() => {
        if (!kw || !hasSearchPlugins) return
        lastKeyRef.current = null
        resetAll()
        // 重试「用户正在看的这个 Tab」：固定重发 'all' 时，单插件 Tab 上的失败只会填
        // 'all' 的缓存，而 rebuild 按当前 Tab 取数 ⇒ 界面上什么都不会变
        void runSearch(activeTabRef.current, kw, 1)
    }, [kw, hasSearchPlugins, resetAll, runSearch])

    /** 翻页没有进展后重试：重发「当前显示窗的下一页」 */
    const retryLoadMore = useCallback(() => {
        if (!kw) return
        setStalled(false)
        void runSearch(activeTabRef.current, kw, displayPageRef.current + 1)
    }, [kw, runSearch])

    /** 关键词 + 插件集合：变了就重置回填 */
    const searchKey = useMemo(
        () => `${kw}|${searchPluginIds.join(',')}`,
        [kw, searchPluginIds],
    )

    /** 已入库歌曲的回填（id / isLiked）：只查增量，且新结果按 key 合并进旧 Map */
    const { map: existingMap, patch: patchExisting } = useExistingBackfill(songs, searchKey)

    // 切换 Tab：显示窗退回到综合基准页码（已走过更深的页仍缓存，但显示回退到基准）
    const handleTabChange = useCallback(
        (tab: 'all' | string) => {
            if (tab === activeTabRef.current) return
            activeTabRef.current = tab
            setActiveTab(tab)
            // 停摆是「上一个 Tab 的那一页」的状态，切 Tab 后不成立
            setStalled(false)
            displayPageRef.current = combinedPageRef.current
            rebuild()
        },
        [rebuild],
    )

    /**
     * 渲染行：原始插件歌曲 + 回填的 id / isLiked。
     * 走 useStableRows：未变化的行复用旧对象身份，这样列的 memo 才生效 ——
     * 点喜欢只重渲染那 1 行，而不是全表。
     */
    const rows = useStableRows<LP.Plugin.Song, SearchRow>(
        songs,
        (s) => songKey(s.pluginId ?? '', s.id),
        (s) => existingMap.get(songKey(s.pluginId ?? '', s.id)),
        (s) => {
            const existing = existingMap.get(songKey(s.pluginId ?? '', s.id))
            return { song: s, id: existing?.id, isLiked: existing?.isLiked ?? false }
        },
    )

    const getRowKey = useCallback((row: SearchRow) => songKey(row.song.pluginId ?? '', row.song.id), [])
    const rowProps = useMemo(
        () => makeSongRowProps<SearchRow>((r) => `${r.song.name} - ${(r.song.singer ?? []).map((x) => x.name).join(' & ')}`),
        [],
    )

    const handleSelectionChange = useCallback((keys: Set<string>) => setSelection(keys), [])

    // 播放：一律基于当前 Tab 可见列表，工具栏不因选中集变化而重渲染
    const { playAll, playFromRow } = useSongListPlayback({ listRef: songsRef, toEntry: asQueueEntry })

    // 本页的行是 SearchRow（外层包着插件歌曲），与队列元素 `LP.Plugin.Song` 不是同一类型，
    // 故 `activateRow` 用不了 —— 自己包一层
    const handleActivate = useCallback((_row: SearchRow, index: number) => playFromRow(index), [playFromRow])

    // 切换喜欢：未入库先落库（ensureSong），再写 isLiked + 我喜欢歌单
    const toggleLike = useCallback(async (row: SearchRow) => {
        const songR = await ensureSong(row.song, row.id)
        if (!isOk(songR)) {
            return
        }
        const song = songR.value
        const isLiked = await toggleSongLike(song)
        if (isLiked === null) return
        // 就地更新该行：id 落定、isLiked 取反
        const k = songKey(row.song.pluginId ?? '', row.song.id)
        patchExisting(k, { ...song, isLiked })
    }, [patchExisting])

    // 点歌手名 → 以该歌手为关键词重新搜索
    const searchSinger = useCallback(
        (name: string) => {
            const kw = name.trim()
            if (!kw) return
            navigateTo(`/search?q=${encodeURIComponent(kw)}`)
        },
        [navigateTo],
    )

    // 行内容
    const renderRow = useCallback(
        (row: SearchRow, ctx: ListRowContext) => {
            const { song } = row
            const singers = song.singer ?? []
            return (
                <>
                    <IndexColumn
                        pluginId={song.pluginId ?? ''}
                        pluginSongId={song.id}
                        index={ctx.index}
                        onPlay={playFromRow}
                    />
                    <PicColumn pic={song.pic}/>
                    <Column className="song-col--title">
                        {/* 歌名直接作为 .song-title（列式 flex）的子项：本页歌名后不挂徽章，
                            故不再套一层 .song-title-main（每行少一个 DOM 节点）。 */}
                        <span className="song-title">
                            <span className="song-name ellipsis">{song.name}</span>
                            {singers.length > 0 ? (
                                <span className="song-singers">
                                    {singers.map((singer, i) => (
                                        <Fragment key={`${singer.name}-${i}`}>
                                            {i > 0 ? <span className="song-singers-sep"> & </span> : null}
                                            <button
                                                className="song-singers-link ellipsis"
                                                type="button"
                                                title={`搜索 ${singer.name}`}
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    searchSinger(singer.name)
                                                }}
                                                onDoubleClick={(e) => e.stopPropagation()}
                                            >
                                                {singer.name}
                                            </button>
                                        </Fragment>
                                    ))}
                                </span>
                            ) : null}
                        </span>
                    </Column>
                    <ActionsColumn>
                        <LikeButton row={row} isLiked={row.isLiked} onToggle={toggleLike}/>
                        <PluginTag pluginId={song.pluginId}/>
                        <QualityTag quality={song.supportQualities}/>
                    </ActionsColumn>
                    <AlbumColumn album={song.album?.name}/>
                    <DurationColumn duration={song.duration}/>
                </>
            )
        },
        [playFromRow, toggleLike, searchSinger],
    )

    /**
     * 右键菜单内容（外部渲染，列表只管显隐与选区收敛）。
     * 收敛后的选区由 arg.selection 给出：右键行已在选区则作用于整个选区，否则仅该行。
     */
    const renderMenu = useCallback(
        ({ selection: sel }: ListMenuArg<SearchRow>): ReactNode => {
            const targets = sel.rows
            const toPluginSongs = () => targets.map((r) => r.song)
            // 结果未入库，音质取自插件返回；一个都没有即不可下载
            const downloadable = targets.some((r) => (r.song.supportQualities?.length ?? 0) > 0)
            // 单选且多音质 →「下载」展开音质子菜单
            const singleQuality = targets.length === 1 ? targets[0].song.supportQualities : undefined
            // 搜索结果尚未入库：入库交给 addSongsTo 的 resolver，失败与入库失败统一计数
            /**
             * 添加到歌单 / 我喜欢。
             *
             * 添加到「我喜欢」后行的心形要立刻亮：`SONG.LIKED` 只带库 id，而刚入库的行
             * 还没进回填表 → 这里按 resolver 的结果就地补一条。
             */
            const addTo = (target: AddTarget) => {
                const liked: { key: string; song: LP.Song }[] = []
                void addSongsTo(targets, target, async (r) => {
                    const ensured = await ensureSong(r.song, r.id)
                    if (isOk(ensured) && target.kind === 'liked') {
                        liked.push({ key: songKey(r.song.pluginId ?? '', r.song.id), song: ensured.value })
                    }
                    return ensured
                }).then(() => {
                    for (const { key, song } of liked) patchExisting(key, { ...song, isLiked: true })
                })
            }

            // 搜索结果尚未入库（LP.Plugin.Song），下载前先 ensureSong 落库为 LP.Song。
            const handleDownload = async (quality?: Quality) => {
                const songs: LP.Song[] = []
                for (const r of targets) {
                    const ensured = await ensureSong(r.song)
                    if (isOk(ensured)) songs.push(ensured.value)
                }
                if (songs.length) void downloadSongs(songs, quality)
            }

            return (
                <>
                    <PlayItem entries={toPluginSongs()}/>
                    <AddToQueueItem entries={toPluginSongs()}/>
                    <ContextMenu.Separator/>
                    <AddToSubMenu
                        playlists={playlists}
                        includeLiked
                        onPickLiked={() => addTo({ kind: 'liked' })}
                        onPickPlaylist={(p) => addTo({ kind: 'playlist', playlist: p })}
                    />
                    <DownloadItem disabled={!downloadable} qualityOptions={singleQuality} onSelect={(q) => void handleDownload(q)}/>
                </>
            )
        },
        [playlists, patchExisting],
    )

    const emptyText = loading
        ? '搜索中…'
        : !hasSearchPlugins
            ? '请先安装或启用支持在线搜索的插件'
            : !kw
                ? '输入关键词开始搜索'
                : songs.length > 0
                    ? ''
                    : failedPlugins > 0
                        ? '搜索失败：插件没有返回结果'
                        : '无搜索结果'

    /** 首屏全失败才给重试：真没结果时重试没有意义 */
    const canRetry = !loading && !!kw && hasSearchPlugins && songs.length === 0 && failedPlugins > 0

    // 表体末尾：加载中 / 已加载全部 / 本页无进展（可重试）
    const footer = stalled ? (
        <div className="search-footer">
            <span>{failedPlugins > 0 ? '加载失败，请重试' : '没有更多结果'}</span>
            <button className="search-retry" type="button" onClick={retryLoadMore}>
                重试
            </button>
        </div>
    ) : loadingMore || (isEnd && songs.length > 0) ? (
        <div className="search-footer">
            {loadingMore ? (
                <>
                    <span className="search-spinner"/>
                    <span>加载中…</span>
                </>
            ) : (
                <span>已加载全部结果</span>
            )}
        </div>
    ) : null

    return (
        <div className="content-page">
            <div className="content-header">
                <div className="content-header-info">
                    <h1 className="content-title ellipsis">{kw ? `搜索'${kw}'` : '搜索'}</h1>
                    <p className="content-meta">
                        {loading
                            ? '搜索中…'
                            : songs.length > 0
                                ? `共 ${total || songs.length} 首，已加载 ${songs.length} 首`
                                : ''}
                    </p>
                </div>
                <div className="content-header-actions">
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

            {showTabs && (
                <div className="search-tabs">
                    {tabs.map((t) => (
                        <button
                            key={t.value}
                            type="button"
                            className={`search-tab${activeTab === t.value ? ' is-active' : ''}`}
                            onClick={() => handleTabChange(t.value)}
                        >
                            {t.label}
                        </button>
                    ))}
                </div>
            )}

            <div className="content-list-wrap">
                {rows.length === 0 ? (
                    <div className="content-empty center">
                        <span>{emptyText}</span>
                        {/* 首屏搜索失败：给重试入口 */}
                        {canRetry ? (
                            <button className="search-retry" type="button" onClick={retrySearch}>
                                重试
                            </button>
                        ) : null}
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
                            deps={[rows]}
                        >
                            <ListView
                                className="song-rows"
                                items={rows}
                                getKey={getRowKey}
                                rowProps={rowProps}
                                selectionMode="multi"
                                selection={selection}
                                onSelectionChange={handleSelectionChange}
                                onActivate={handleActivate}
                                renderContextMenu={renderMenu}
                                menuClassName="context-menu--search"
                                renderRow={renderRow}
                            />
                            <div ref={sentinelRef} className="search-sentinel"/>
                            {footer}
                        </ScrollArea>
                    </>
                )}
            </div>
        </div>
    )
}
