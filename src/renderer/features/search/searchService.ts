import { executePluginCommand } from '@renderer/features/plugin/pluginService'
import { isOk } from '@shared/result'
import { usePluginStore } from '@renderer/store'

/**
 * 音乐源插件 search 命令返回契约（见插件开发文档）：
 *   (query, { page, pageSize }) => { songs: LP.Plugin.Song[], total, isEnd }
 * 兼容两种退化写法：插件直接返回歌曲数组，或返回 { songs } 但不给 total / isEnd
 * （此时按「本页条数 < pageSize」推断已到末页）。
 */
interface PluginSearchPayload {
    success?: boolean
    songs?: LP.Plugin.Song[]
    total?: number
    isEnd?: boolean
    error?: string
}

/** 单页搜索结果（多插件聚合后） */
interface SearchPageResult {
    songs: LP.Plugin.Song[]
    /** 各插件 total 之和（用于「共 N 首」展示） */
    total: number
    /** 所有插件都已到末页时为 true */
    isEnd: boolean
    /** 本次请求「失败」的插件数（用于区分「插件挂了」与「真的没结果」） */
    failed: number
}

/** 搜索页分页大小 */
export const SEARCH_PAGE_SIZE = 20

/** 插件返回是否可用：没返回 / 明确 success:false / 结构不对 都算不可用 */
function isValidPayload(
    payload: PluginSearchPayload | LP.Plugin.Song[] | undefined,
): payload is PluginSearchPayload | LP.Plugin.Song[] {
    if (!payload) return false
    if (Array.isArray(payload)) return true
    if (payload.success === false) return false
    return Array.isArray(payload.songs)
}

/** 这次请求算不算失败（单插件分支用） */
function isPluginFailure(payload: PluginSearchPayload | LP.Plugin.Song[] | undefined): boolean {
    return !isValidPayload(payload)
}

/**
 * 把单个插件的 search 返回收敛为 LP.Plugin.Song[]（注入 pluginId、按 songKey 去重）。
 * 返回 { songs, total, isEnd }，供综合 / 单插件两种模式复用。
 */
function normalizePluginResult(
    payload: PluginSearchPayload | LP.Plugin.Song[] | undefined,
    pluginId: string,
    pageSize: number,
): { songs: LP.Plugin.Song[]; total: number; isEnd: boolean } {
    if (!payload) return { songs: [], total: 0, isEnd: true }
    const list = Array.isArray(payload) ? payload : payload.success === false ? [] : payload.songs
    if (!Array.isArray(list)) return { songs: [], total: 0, isEnd: true }

    const songs: LP.Plugin.Song[] = []
    const seen = new Set<string>()
    for (const song of list) {
        if (!song || typeof song !== 'object') continue
        if (typeof song.id !== 'string' || typeof song.name !== 'string') continue
        const pid = song.pluginId || pluginId
        const key = `${pid}:${song.id}`
        if (seen.has(key)) continue
        seen.add(key)
        // 宿主职责：插件返回的歌曲不带 pluginId（SDK 约定由宿主注入），必须回填 ——
        // 否则后续落库 plugin_id 为 NULL、行 key 退化成 "undefined:id"。
        songs.push(song.pluginId === pid ? song : { ...song, pluginId: pid })
    }

    const total = Array.isArray(payload) ? list.length : (payload.total ?? list.length)
    const isEnd = Array.isArray(payload)
        ? list.length < pageSize
        : (payload.isEnd ?? list.length < pageSize)
    return { songs, total, isEnd }
}

/**
 * 聚合调用所有支持 search 命令的插件，取第 page 页结果合并去重（「综合」模式）。
 * 单个插件失败（未注册 / 网络异常 / 返回格式异常）静默跳过，不影响其他插件。
 * @param keyword 搜索关键词
 * @param page 页码（从 1 开始）
 * @param pageSize 每页条数
 * @param pluginId 指定时只搜该插件（单插件模式，供具体 Tab 翻页）
 */
export async function searchSongsByPlugin(
    keyword: string,
    page = 1,
    pageSize = SEARCH_PAGE_SIZE,
    pluginId?: string,
): Promise<SearchPageResult> {
    const kw = keyword.trim()
    if (!kw) return { songs: [], total: 0, isEnd: true, failed: 0 }

    const allIds = usePluginStore.getState().commandMap['search'] ?? []
    if (allIds.length === 0) return { songs: [], total: 0, isEnd: true, failed: 0 }

    // 单插件模式：只搜指定插件
    if (pluginId) {
        if (!allIds.includes(pluginId)) return { songs: [], total: 0, isEnd: true, failed: 0 }
        const r = await executePluginCommand<PluginSearchPayload | LP.Plugin.Song[]>(
            pluginId,
            'search',
            kw,
            { page, pageSize },
        )
        const payload = isOk(r) ? r.value : undefined
        return {
            ...normalizePluginResult(payload, pluginId, pageSize),
            failed: isPluginFailure(payload) ? 1 : 0,
        }
    }

    // 综合模式：搜全部插件
    const settled = await Promise.allSettled(
        allIds.map((id) =>
            executePluginCommand<PluginSearchPayload | LP.Plugin.Song[]>(id, 'search', kw, {
                page,
                pageSize,
            }).then((r) => ({ id, r })),
        ),
    )

    const songs: LP.Plugin.Song[] = []
    const seen = new Set<string>()
    let total = 0
    let allEnd = true
    let failed = 0

    for (const s of settled) {
        if (s.status !== 'fulfilled') {
            failed++
            continue
        }
        const { id, r } = s.value
        const payload = isOk(r) ? r.value : undefined
        if (!isValidPayload(payload)) {
            failed++
            continue
        }

        const list = Array.isArray(payload) ? payload : payload.success === false ? [] : payload.songs
        if (!Array.isArray(list)) continue

        for (const song of list) {
            if (!song || typeof song !== 'object') continue
            if (typeof song.id !== 'string' || typeof song.name !== 'string') continue
            const pid = song.pluginId || id
            const key = `${pid}:${song.id}`
            if (seen.has(key)) continue
            seen.add(key)
            songs.push(song.pluginId === pid ? song : { ...song, pluginId: pid })
        }

        if (Array.isArray(payload)) {
            total += list.length
            if (list.length >= pageSize) allEnd = false
        } else {
            total += payload.total ?? list.length
            // 插件显式声明 isEnd 时以它为准；
            // 只有未声明才按「本页是否满页」推断。
            // ⚠️ 旧口径 `isEnd !== true && list.length >= pageSize` 会忽略显式 false ——
            // 服务端分页插件返回不满页是常态，会被误判到底而提前截断。
            const ended = payload.isEnd ?? list.length < pageSize
            if (!ended) allEnd = false
        }
    }

    return { songs, total, isEnd: allEnd, failed }
}
