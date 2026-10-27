import { useSettingsStore } from '@renderer/store'
import { ok, fail } from '@shared/result'
import { rlog } from '@renderer/lib/log'
import { clearFileMissing, markFileMissing } from '@renderer/lib/localFileCheck'
import { type ProbeSink } from './linkProviders'
import { resolveSource } from './sourceResolver'


/**
 * 取源层的门面 / 组合根 —— 对外只有 `getSongLink`。
 *
 * - 读用户偏好（首选音质）→ 以值传给 `sourceResolver`；
 * - 把结构化结果转成 `Result`；
 * - 把本地探测结果落到「文件缺失」提示层。
 */

/** 解析出的最终播放链接（带实际采用的音质，供引擎与 UI 直接使用）。 */
export interface ResolvedSongLink {
    /** 实际拿到并可播放的音质（可能因指定音质不可用而被兜底替换） */
    quality: Quality
    /** 本地路径或在线 URL */
    url: string
}

/** 用户偏好在这里取一次，往下都以值传递 */
function readPreferredQuality(): Quality {
    return useSettingsStore.getState().settings['player.preferredQuality']
}

/**
 * 本地探测 → 提示层的唯一施加点。
 * 探测发生在取源层（每次探测立刻回调），副作用只在这一处落地：
 * 在 = 清掉陈旧标记（文件被放回磁盘 / 重新下载 → 行立刻恢复），不在 = 记到运行期缺失层。
 */
const probeSink: ProbeSink = (path, exists) => {
    if (exists) clearFileMissing(path)
    else markFileMissing(path)
}

/**
 * 获取歌曲播放链接。
 *
 * 顺带维护「本地文件缺失」的提示层（`lib/localFileCheck`）：这里是唯一的取链
 * 入口，所以运行期发现的缺失必须在这一层落标记。
 */
export async function getSongLink(song: LP.Song, requested?: Quality): Promise<Result<ResolvedSongLink>> {
    const preferred = readPreferredQuality()
    const outcome = await resolveSource(song, requested, { preferred, onProbe: probeSink })
    if (outcome.kind === 'fail') {
        const { reason, message: reasonText } = outcome.failure
        rlog.warn(
            `[player] 取链接失败 [${reason}] ${song.name}-${song.singer}（id=${song.id}, ` +
            `请求 ${requested ?? '未指定'} / 首选 ${preferred}）：${reasonText}`,
        )
        return fail(reasonText)
    }

    const { quality, url, from } = outcome.source
    // 只有本地来源才谈得上「缺失标记」；在线链接不参与这套提示层。
    if (from === 'local' || from === 'fallback') clearFileMissing(url)
    return ok({ quality, url })
}
