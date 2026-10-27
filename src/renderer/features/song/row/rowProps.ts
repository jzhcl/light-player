import { useCallback } from 'react'
import type { RowIdentity } from '@renderer/components/ListView'
import { useMissingPaths } from '@renderer/lib/localFileCheck'
import { normalizePath } from '@shared/utils'

/**
 * 行容器类名：`song-row`（行本体几何 / 状态色）+ `song-grid`（列栅格）。
 * 列里的 hover 样式（如序号列换播放按钮）以它为锚，两侧共用同一常量，避免字符串漂移。
 */
const SONG_ROW_CLASS = 'song-row song-grid'

/**
 * 行容器 DOM 属性工厂。
 *
 * 语义角色与可访问名称由页面层给出；
 * title 依各页面的行类型取，故由调用方给取值函数。
 * `extraClass` 供页面追加样式类。
 *
 * ⚠️ 两条要求：
 *  1. 必须是纯函数：列表会按 `(item 身份, index)` 缓存它的返回值，闭包里不可捕获可变状态
 *     （要随外部状态变，就让函数本身换身份 —— 见下一条）。
 *  2. 返回值须在页面里 useMemo 稳定：列表以「函数身份是否变化」判定缓存是否过期。
 *     传内联箭头函数 ⇒ 每次渲染都换身份 ⇒ 行外壳缓存整体失效，改一行重渲全表。
 */
export function makeSongRowProps<T>(titleOf: (row: T) => string, extraClass?: string) {
    const className = extraClass ? `${SONG_ROW_CLASS} ${extraClass}` : SONG_ROW_CLASS
    return (item: T, ctx: RowIdentity) => ({
        className,
        role: 'row' as const,
        'aria-rowindex': ctx.index + 1,
        title: titleOf(item),
    })
}

/**
 * 「本地文件已丢失」的行容器类名（`is-missing`），只认本机导入的歌曲。
 *
 * 灰化 ⇔ 这首歌真的播不了 —— 见 `features/player/songLinkService.ts` 的取链顺序：
 *  - `pluginId === 'local'`（本机导入）：本地文件没了就直接 `fail`，没有在线源 → 不可播；
 *  - 下载歌曲：本地副本没了会落到插件的在线请求 → 照样能播，灰化等于谎报「这首废了」。
 *
 * - 搜索页结果一律 `LP.Plugin.Song`（插件在线结果，`pluginId` 不可能为 `'local'`）→ 永远判不出缺失，接了就是死代码。
 * - 「本地与下载」页：那一页是文件盘点（一行 = 一个文件），两类歌曲都要灰，
 *   口径是 `f.quality.path` 而非「歌曲」，见该页自己的 `rowClassName`。
 */

/** 给一首歌算行容器类名 */
export function songRowClassName(song: LP.Song, missing: ReadonlySet<string>): string {
    if (song.pluginId !== 'local') return ''
    for (const q of song.downloadQualities ?? []) {
        if (missing.has(normalizePath(q.path))) return 'is-missing'
    }
    return ''
}

/**
 * 列表页用：返回可直接交给 `ListView.rowClassName` 的取值函数。
 *
 * 返回值随缺失集合变化而换身份 —— 只会让列表重算一遍行外壳，
 * 不会让整个列表重绘（`Row` 仍是 memo，只有类名真变了的行才重画）。
 */
export function useSongRowClassName(): (song: LP.Song) => string {
    const missing = useMissingPaths()
    return useCallback((song: LP.Song) => songRowClassName(song, missing), [missing])
}
