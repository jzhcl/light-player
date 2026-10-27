import { isFileExists } from '@renderer/lib/file'
import { pluginInvoke } from '@renderer/lib/plugin'
import { validateLink } from '@renderer/lib/utils'
import { isOk } from '@shared/result'
import { nearestFirst, supportedQualities } from './resolveQuality'


/**
 * 取源的两个 provider：本地文件 / 插件。
 *
 * - 不做副作用。本地探测出的「在 / 不在」只通过 `ProbeSink` 回调交给调用方。
 * - 不读设置。偏好（首选音质）以具体档位传进来的。
 * - 只回答「有没有、是什么」，不决定「用不用」（那是编排层的事）。
 */

/**
 * 本地探测的出口：每次探测后立刻回调，调用方据此维护「文件缺失」提示层。
 * 立刻回调（而不是事后批量）是为了保持时序 ——
 * 否则提示层的写入会推迟到一次插件网络往返之后。
 */
export type ProbeSink = (path: string, exists: boolean) => void

/** 一条已定档的可用链接 */
export interface PickedLink {
    quality: Quality
    url: string
}

/** 默认的探测出口：不关心（下载器等消费方不需要提示层） */
const NOOP_SINK: ProbeSink = () => {
}

/**
 * 步骤①：目标音质对应的那份本地文件。
 * @returns 命中则返回它；文件在记录里但读不到 → 回调 `(path,false)` 并返回 null
 */
export async function probeLocalFile(
    song: LP.Song,
    targetQuality: Quality,
    onProbe: ProbeSink = NOOP_SINK,
): Promise<PickedLink | null> {
    const local = song.downloadQualities?.find((q) => q.type === targetQuality)
    if (!local?.path) return null

    const exists = await isFileExists(local.path)
    onProbe(local.path, exists)
    return exists ? { quality: targetQuality, url: local.path } : null
}

/**
 * 步骤④：本地兜底 —— 在线路径全部失败后，从这首歌已下载的本地文件里按「最接近目标音质」挑一个还在的。
 * 只在救场时才用，不参与正常路径。
 */
export async function probeLocalFallback(
    song: LP.Song,
    targetQuality: Quality,
    onProbe: ProbeSink = NOOP_SINK,
): Promise<PickedLink | null> {
    const downloaded = song.downloadQualities ?? []
    if (!downloaded.length) return null

    for (const q of nearestFirst(targetQuality)) {
        const hit = downloaded.find((d) => d.type === q && d.path)
        if (!hit?.path) continue
        const exists = await isFileExists(hit.path)
        onProbe(hit.path, exists)
        if (exists) return { quality: q, url: hit.path }
    }
    return null
}

/**
 * 将插件返回的「音质→链接」映射，解析出一条可校验通过的链接。
 * 顺序：目标音质 > 按与目标的接近程度逐级扩散（先降级、后升级）。
 * @returns 命中的 { quality, url }；全部候选都不可用或无候选时返回 null。
 */
async function resolveFromPluginMap(
    map: Record<string, unknown>,
    song: LP.Song,
    targetQuality: Quality,
): Promise<PickedLink | null> {
    const supported = supportedQualities(song)
    const candidates = Object.entries(map)
        .filter(([q]) => supported.includes(q as Quality) && typeof map[q] === 'string')
        .map(([q, url]) => ({ quality: q as Quality, url: url as string }))
    if (!candidates.length) return null

    const ordered: PickedLink[] = []
    for (const q of nearestFirst(targetQuality)) {
        const hit = candidates.find((c) => c.quality === q)
        if (hit) ordered.push(hit)
    }

    for (const c of ordered) {
        if (await validateLink(c.url)) return c
    }
    return null
}

/**
 * 把插件返回值（字符串 URL / 音质→链接映射 / 其它）解析成一条可用链接。
 * 不抛异常；拿不到就返回具体的失败原因，供上层累积。
 */
async function pickFromPluginValue(
    value: unknown,
    song: LP.Song,
    targetQuality: Quality,
): Promise<{ picked: PickedLink | null; error: string | null }> {
    if (value == null) return { picked: null, error: `插件【${song.pluginId}】未返回链接数据` }

    if (typeof value === 'string') {
        // 直接返回 URL 字符串：当作目标音质
        if (await validateLink(value)) return { picked: { quality: targetQuality, url: value }, error: null }
        return { picked: null, error: '插件返回的链接校验未通过（可能已失效）' }
    }

    if (typeof value === 'object') {
        const picked = await resolveFromPluginMap(value as Record<string, unknown>, song, targetQuality)
        return { picked, error: picked ? null : '插件未返回可用的播放链接' }
    }

    return { picked: null, error: '插件返回的链接数据格式无法识别' }
}

/**
 * 步骤③：向插件请求链接，并解析它的两种契约（字符串 / 音质→链接映射）。
 * @returns 命中的链接（`picked`）或给用户看的中文失败原因（`error`）
 */
export async function requestPluginLink(
    song: LP.Song,
    targetQuality: Quality,
): Promise<{ picked: PickedLink | null; error: string | null }> {
    const r = await pluginInvoke<unknown>(song.pluginId, 'getSongLink', song.meta ?? {}, { quality: targetQuality })
    if (!isOk(r)) return { picked: null, error: `通过插件【${song.pluginId}】获取链接失败：${r.error}` }
    return pickFromPluginValue(r.value, song, targetQuality)
}
