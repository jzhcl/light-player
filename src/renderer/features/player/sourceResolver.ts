import { resolveQuality } from './resolveQuality'
import { getCachedLink, setCachedLink } from './linkCache'
import { probeLocalFallback, probeLocalFile, requestPluginLink, type ProbeSink } from './linkProviders'
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
    reason: 'no-quality' | 'local-missing' | 'local-denied' | 'provider-unavailable'
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

/** 「没权限读本地文件」的固定前缀 */
export const LOCAL_DENIED_PREFIX = '没有权限读取本地文件'

export function isLocalDeniedFailure(message: string): boolean {
    return message.startsWith(LOCAL_DENIED_PREFIX)
}

/**
 * 读不了的本地文件，文案要说清「是没授权，不是文件丢了、更不是格式不支持」。
 *
 * macOS 上这类目录（下载 / 桌面 / 文稿）由 TCC 管，用户只能去系统设置里放行；
 * 其他平台多半是权限位问题。
 */
function deniedMessage(path: string): string {
    const how = window.env.platform === 'darwin'
        ? '到「系统设置 → 隐私与安全性 → 文件与文件夹」中允许 LightPlayer 访问后重试'
        : '请检查该文件的权限后重试'
    return `${LOCAL_DENIED_PREFIX}：${path}。${how}`
}

export async function resolveSource(
    song: LP.Song,
    requested: Quality | undefined,
    ctx: ResolveContext,
): Promise<ResolveOutcome> {
    const qR = resolveQuality(song, requested, ctx.preferred)
    if (!isOk(qR)) return fail('no-quality', qR.error)
    const targetQuality = qR.value

    // ① 本地文件：由 provider 探测，能读即用
    const local = await probeLocalFile(song, targetQuality, ctx.onProbe)
    if (local.picked) return ok({ ...local.picked, from: 'local' })

    // 纯本地身份：这份文件就代表这首歌，读不了 / 不在都到此为止，不再往下找在线
    if (song.pluginId === 'local') {
        return fail(
            local.deniedPath ? 'local-denied' : 'local-missing',
            local.deniedPath ? deniedMessage(local.deniedPath) : `本地文件已丢失：${song.name}`,
        )
    }

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
    if (fallback.picked) return ok({ ...fallback.picked, from: 'fallback' })

    // 在线也拿不到，而本地那份是「读不了」而非「不在」→ 权限才是要用户动手的那一条
    const deniedPath = local.deniedPath ?? fallback.deniedPath
    if (deniedPath) return fail('local-denied', deniedMessage(deniedPath))

    return fail('provider-unavailable', providerError ?? '当前歌曲无可用播放链接')
}
