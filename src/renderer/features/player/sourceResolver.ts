import { resolveQuality } from './resolveQuality'
import { getCachedLink, setCachedLink } from './linkCache'
import { probeLocalFallback, probeLocalFile, requestPluginLink, type PickedLink, type ProbeSink } from './linkProviders'
import { isOk } from '@shared/result'


/**
 * 取源编排层：把「音质策略 + 各 provider」按序串起来，返回结构化结果。
 *
 * - 不读设置：偏好（首选音质）以 `ctx.preferred` 值入参；
 * - 不写提示层：本地探测结果经 `ctx.onProbe` 回调出去，由唯一消费点施加；
 * - 不认识播放引擎：谁拿这条源去播由调用方决定 —— 所以下载器也能复用它。
 *
 * 顺序：
 *  ① 本地文件（目标音质对应的那份存在即用）
 *  ② 内存链接缓存（TTL 30 分钟，见 `linkCache`）
 *  ③ 插件（防御解析 字符串 / 对象 两种契约）
 *  ④ 本地兜底（在线全失败时，从本地其它音质的文件里就近救场）
 */

/** 这条源是从哪一支拿到的（诊断用，也是「该不该清缺失标记」的判据） */
export type SourceOrigin = 'local' | 'cache' | 'plugin' | 'fallback'

export interface ResolvedSource {
    quality: Quality
    url: string
    from: SourceOrigin
}

export interface ResolveFailure {
    reason: 'no-quality' | 'local-missing' | 'provider-unavailable'
    /** 已经是给用户看的中文，调用方直接透传给 `PLAYER.ERROR` / toast */
    message: string
}

export type ResolveOutcome =
    | { kind: 'ok'; source: ResolvedSource }
    | { kind: 'fail'; failure: ResolveFailure }

export interface ResolveContext {
    /** 用户偏好的档位 */
    preferred: Quality
    /** 本地探测出口（提示层由调用方施加）。省略 = 不关心 */
    onProbe?: ProbeSink
}

const ok = (source: ResolvedSource): ResolveOutcome => ({ kind: 'ok', source })
const fail = (reason: ResolveFailure['reason'], message: string): ResolveOutcome => ({
    kind: 'fail',
    failure: { reason, message },
})

export async function resolveSource(
    song: LP.Song,
    requested: Quality | undefined,
    ctx: ResolveContext,
): Promise<ResolveOutcome> {
    const qR = resolveQuality(song, requested, ctx.preferred)
    if (!isOk(qR)) return fail('no-quality', qR.error)
    const targetQuality = qR.value

    // ① 本地文件：由 provider 探测，命中即用
    const local: PickedLink | null = await probeLocalFile(song, targetQuality, ctx.onProbe)
    if (local) return ok({ ...local, from: 'local' })

    // 纯本地身份：唯一的那份文件没了就是没得播，不再往下找在线
    if (song.pluginId === 'local') return fail('local-missing', `本地文件已丢失：${song.name}`)

    // ② 内存链接缓存
    const cached = getCachedLink(song.id, targetQuality)
    if (cached) return ok({ quality: targetQuality, url: cached, from: 'cache' })

    // ③ 插件
    let providerError: string | null = null
    if (song.pluginId) {
        const { picked, error } = await requestPluginLink(song, targetQuality)
        if (picked) {
            setCachedLink(song.id, picked.quality, picked.url)
            return ok({ ...picked, from: 'plugin' })
        }
        providerError = error
    }

    // ④ 本地兜底
    const fallback = await probeLocalFallback(song, targetQuality, ctx.onProbe)
    if (fallback) return ok({ ...fallback, from: 'fallback' })

    return fail('provider-unavailable', providerError ?? '当前歌曲无可用播放链接')
}
