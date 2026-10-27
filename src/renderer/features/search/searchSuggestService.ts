import { executePluginCommand } from '@renderer/features/plugin/pluginService'
import { isOk } from '@shared/result'
import { LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME } from '@renderer/lib/constants'
import { usePluginStore, usePlaylistStore } from '@renderer/store'
import { getFirstPlaylistIdsBySongIds, getPlayedSongIds, searchSongs } from '@renderer/lib/db'


/**
 * 单条搜索建议
 */
export interface SearchSuggestion {
    /** 用于搜索/补全的完整文本（歌名、歌手、关键词等） */
    text: string
    /** 副信息（歌手 - 专辑 / 说明），插件建议为纯文本词条，无副信息 */
    sub?: string
    /** 来源分组：插件返回 / 本地检索 */
    source: 'plugin' | 'local'
    /** 来源名，仅本地组展示（插件组不显示来源，对执行搜索无贡献） */
    sourceName?: string
    /**
     * 点击该项要跳转的路由。
     *  - 插件建议：`/search?q=${encodeURIComponent(text)}` —— 即按该词条执行搜索
     *  - 本地建议：`/playlist/:id`、`/liked`、`/local-download`、`/recent`
     */
    path: string
}

/** 建议分组：插件组（搜索建议 / 热门搜索）与本地组 */
export interface SuggestionGroup {
    key: 'plugin' | 'local'
    title: string
    items: SearchSuggestion[]
}

/**
 * 插件建议命令：
 *  - searchSuggest(keyword) → { items: string[] }
 *  - hotSearch()            → { items: string[] }
 * 两者都只返回纯文本词条，宿主拿到后当作搜索关键词使用。
 */
type SuggestCommand = 'searchSuggest' | 'hotSearch'

/**
 * 插件命令的业务返回。主进程 plugin:invoke 仅做 Result 包装
 * （ok(插件原始返回) / fail(异常)），故 Result.value 即插件原始返回值。
 */
interface PluginSuggestPayload {
    success?: boolean
    items?: string[]
    error?: string
}

/**
 * 聚合调用所有支持该命令的插件，合并 items 并按首次出现顺序去重。
 * 单个插件失败（未注册命令 / 网络异常 / 返回格式异常）静默跳过，不影响其他插件与本地组。
 */
async function aggregatePluginItems(command: SuggestCommand, keyword?: string): Promise<string[]> {
    const pluginIds = usePluginStore.getState().commandMap[command] ?? []
    if (pluginIds.length === 0) return []

    const settled = await Promise.allSettled(
        pluginIds.map((id) =>
            keyword === undefined
                ? executePluginCommand<PluginSuggestPayload | string[]>(id, command)
                : executePluginCommand<PluginSuggestPayload | string[]>(id, command, keyword),
        ),
    )

    const items: string[] = []
    for (const s of settled) {
        if (s.status !== 'fulfilled') continue
        const r = s.value
        if (!isOk(r)) continue
        const payload = r.value
        if (!payload) continue
        // 契约为 { items }，同时兼容插件直接返回字符串数组的退化写法
        const list = Array.isArray(payload) ? payload : payload.success === false ? [] : payload.items
        if (!Array.isArray(list)) continue
        for (const t of list) {
            if (typeof t === 'string' && t.trim()) items.push(t)
        }
    }
    return [...new Set(items)]
}

/** 插件词条 → 建议项 */
const toPluginSuggestions = (items: string[]): SearchSuggestion[] =>
    items.map((text) => ({
        text,
        source: 'plugin',
        path: `/search?q=${encodeURIComponent(text)}`,
    }))

/* ================================================================
   本地检索建议：只查已入库歌曲（songs 表），命中即给出「它在哪」（即 path）
   ================================================================ */


/**
 * 本地检索建议
 *
 * 定位优先级：所在歌单 > 本地 > 最近播放。
 */
async function fetchLocalSuggestions(keyword: string): Promise<SearchSuggestion[]> {
    const songs = await searchSongs(keyword)
    if (!isOk(songs)) return []

    const top = songs.value.slice(0, 6)
    if (top.length === 0) return []

    const songIds = top.map((s) => s.id)
    const [firstPlaylistMap, playedIds] = await Promise.all([
        getFirstPlaylistIdsBySongIds(songIds),
        getPlayedSongIds(songIds),
    ])

    const firstPlaylist = !isOk(firstPlaylistMap) ? new Map<string, string>() : firstPlaylistMap.value
    const played = !isOk(playedIds) ? new Set<string>() : playedIds.value

    const playlistName = new Map<string, string>(
        usePlaylistStore.getState().playlists.map((p) => [p.id, p.name]),
    )
    playlistName.set(LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME)

    const items: SearchSuggestion[] = []
    for (const song of top) {
        const playlistId = firstPlaylist.get(song.id)
        let path: string
        let sourceName: string | undefined

        if (playlistId) {
            path = playlistId === LIKED_PLAYLIST_ID ? '/liked' : `/playlist/${playlistId}`
            // 歌单名查不到时不给角标，但 path 照留
            sourceName = playlistName.get(playlistId)
        } else if (song.pluginId === 'local') {
            path = '/local-download'
            sourceName = '本地'
        } else if (played.has(song.id)) {
            path = '/recent'
            sourceName = '最近播放'
        } else {
            continue
        }

        items.push({
            text: song.name,
            sub: song.singer || undefined,
            source: 'local',
            sourceName,
            path,
        })
    }
    return items
}

/* ================================================================
   对外接口
   ================================================================ */

/**
 * 有输入文本时的搜索建议：插件组（聚合 searchSuggest）+ 本地组。
 */
export async function fetchSuggestions(query: string): Promise<SuggestionGroup[]> {
    const kw = query.trim()
    if (!kw) return []

    const [pluginItems, localItems] = await Promise.all([
        aggregatePluginItems('searchSuggest', kw),
        fetchLocalSuggestions(kw),
    ])

    const groups: SuggestionGroup[] = [
        { key: 'plugin', title: '搜索建议', items: toPluginSuggestions(pluginItems) },
        { key: 'local', title: '本地', items: localItems },
    ]
    return groups.filter((g) => g.items.length > 0)
}

/** 无输入文本时的热门搜索 */
export async function fetchHotSearch(): Promise<SuggestionGroup[]> {
    const items = await aggregatePluginItems('hotSearch')
    if (items.length === 0) return []
    return [{ key: 'plugin', title: '热门搜索', items: toPluginSuggestions(items) }]
}
