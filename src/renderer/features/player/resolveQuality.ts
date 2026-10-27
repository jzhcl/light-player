import { qualityLabel } from '@shared/format'
import { ok, fail, isOk } from '@shared/result'
import { QUALITY_BY_BITRATE } from '@renderer/lib/constants'

/**
 * 音质解析的纯算法层
 */

/** 歌曲声明支持的档位 */
export function supportedQualities(song: LP.Song): Quality[] {
    return (song.supportQualities ?? []).map((q) => q.type)
}

/**
 * 以 target 为中心、按「最接近」排好候选序列：target → 逐级降低 → 逐级升高。
 */
export function nearestFirst(target: Quality): Quality[] {
    const ti = QUALITY_BY_BITRATE.indexOf(target)
    // 未知档理论上不可达，退回「尽量高」的旧行为。
    if (ti < 0) return [...QUALITY_BY_BITRATE]
    return [
        target,
        ...QUALITY_BY_BITRATE.slice(ti + 1),             // 比 target 差：由高到低（最像的先）
        ...QUALITY_BY_BITRATE.slice(0, ti).reverse(),    // 比 target 好：由低到高（最像的先）
    ]
}

/**
 * 解析最终采用的音质。优先级：调用方指定 > 传入的首选音质。
 * 就近回退：在 <= 首选档的可用音质里取最高的一档；只有更高档时才向上取最接近的一档。
 *
 * @param song
 * @param requested
 * @param preferred 用户偏好的档位
 */
export function resolveQuality(song: LP.Song, requested: Quality | undefined, preferred: Quality): Result<Quality> {
    const supported = supportedQualities(song)
    if (!supported.length) return fail(`歌曲【${song.name}】无可用音质`)

    const target = requested ?? preferred
    // nearestFirst 是全音质序列的一个排列，supported 非空时必然命中；`supported[0]` 只是不可达兜底。
    return ok(nearestFirst(target).find((q) => supported.includes(q)) ?? supported[0])
}

/**
 * 控制栏音质徽章的「常显」口径：
 *   ① `playbackQuality` 有值 = 引擎真的在播这一档（事实）
 *   ② 有歌但还没有事实（刚启动只恢复了 `currentSong`、流还没装载）= 按 `resolveQuality` 算出会播哪一档
 *   ③ 没有歌 = 全局首选
 */
export function displayQuality(
    song: LP.Song | null | undefined,
    playbackQuality: Quality | null | undefined,
    preferred: Quality,
): Quality {
    if (playbackQuality) return playbackQuality
    if (!song) return preferred
    const resolved = resolveQuality(song, undefined, preferred)
    return isOk(resolved) ? resolved.value : preferred
}

/**
 * 描述「歌曲提供的档位」与「全局首选档」的差距，供控制栏面板显示；无需提示时返回 null。
 * 措辞按缺失多寡择一：缺失更少 → 「不提供 X、Y」；缺失更多或持平 → 「仅提供 X、Y」。
 */
export function describeQualityGap(song: LP.Song, preferred: Quality): string | null {
    const supported = supportedQualities(song)
    if (!supported.length) return '当前歌曲未提供音质信息'
    if (supported.includes(preferred)) return null

    const join = (qs: Quality[]): string => qs.map(qualityLabel).join('、')
    const missing = QUALITY_BY_BITRATE.filter((q) => !supported.includes(q))
    const present = QUALITY_BY_BITRATE.filter((q) => supported.includes(q))
    return missing.length < supported.length
        ? `当前歌曲不提供${join(missing)}`
        : `当前歌曲仅提供${join(present)}`
}
