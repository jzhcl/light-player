import { createSongLyric, getSongLyricBySongId, updateSongLyric } from '@renderer/lib/db'
import { parseAudioMetadata } from '@renderer/lib/audio'
import { executePluginCommand } from '@renderer/features/plugin/pluginService'
import { ok, isOk } from '@shared/result'
import { formatDate } from '@shared/format'


function emptyLyric(songId: string): LP.SongLyric {
    return {
        songId,
        lyric: '',
        klyric: [],
        tlyric: '',
        rlyric: '',
        createdAt: formatDate(),
        updatedAt: formatDate(),
    }
}

/** 读取歌词；不存在则懒创建空记录后返回。 */
export async function getOrCreateSongLyric(songId: string): Promise<Result<LP.SongLyric>> {
    const existing = await getSongLyricBySongId(songId)
    if (!isOk(existing)) return existing
    if (existing.value) return ok(existing.value)

    const created = await createSongLyric(emptyLyric(songId))
    if (!isOk(created)) return created
    return ok(emptyLyric(songId))
}

/** 保存歌词 */
export async function saveSongLyric(songId: string, data: Partial<Omit<LP.SongLyric, 'createdAt' | 'updatedAt'>>) {
    const existing = await getSongLyricBySongId(songId)
    if (!isOk(existing)) return existing
    return existing
        ? updateSongLyric(songId, data)
        : createSongLyric({
              songId,
              lyric: data.lyric ?? '',
              klyric: data.klyric ?? [],
              tlyric: data.tlyric,
              rlyric: data.rlyric,
          })
}

/** 主进程 `plugin:invoke` 原样透传插件返回对象，故这里额外带上插件侧的 success 标记。 */
type PluginLyricPayload = LP.Plugin.SongLyric & { success?: boolean }

/**
 * 把插件返回的逐字歌词归一化为库侧结构。
 * 插件侧 `words.duration` 必填、没有 `end`，而库侧两者皆可选，下游统一按
 * `end ?? start + duration` 取值——这里补齐 `end`，让两条来源的数据形态一致。
 */
function normalizeKrcLines(input: LP.KrcLine[] | undefined): LP.KrcLine[] {
    if (!Array.isArray(input)) return []
    return input.map((line) => ({
        start: line.start,
        duration: line.duration,
        words: (line.words ?? []).map((w) => ({
            start: w.start,
            duration: w.duration,
            end: w.end ?? w.start + (w.duration ?? 0),
            word: w.word,
        })),
    }))
}

/**
 * 本地歌曲：从音频文件的内嵌标签取歌词。
 *
 * 只取「有 text 且没有同步歌词行」的标签——syncText 是结构化行，宿主没有可直接
 * 使用的 LRC 文本。解析失败不阻断：本地文件没内嵌歌词是常态，不是错误。
 */
async function fetchLocalLyric(song: LP.Song): Promise<Partial<LP.SongLyric> | null> {
    const metaR = await parseAudioMetadata(song.pluginSongId)
    if (!isOk(metaR)) return null

    for (const tag of metaR.value.common.lyrics ?? []) {
        if (tag.text && !tag.syncText?.length) return { lyric: tag.text }
    }
    return null
}

/** 在线歌曲：向来源插件要歌词。插件侧标记失败时返回 null（当作「这首歌没有歌词」）。 */
async function fetchPluginLyric(song: LP.Song): Promise<Result<Partial<LP.SongLyric> | null>> {
    const r = await executePluginCommand<PluginLyricPayload>(song.pluginId, 'getSongLyric', song.meta)
    if (!isOk(r)) return r

    const payload = r.value
    if (!payload || payload.success === false) return ok(null)

    return ok({
        lyric: payload.lyric ?? '',
        klyric: normalizeKrcLines(payload.klyric),
        tlyric: payload.tlyric ?? '',
        rlyric:
            typeof payload.rlyric === 'string'
                ? payload.rlyric
                : normalizeKrcLines(payload.rlyric),
    })
}

/**
 * 读取歌曲歌词；缺失时按来源补拉并写回数据库。
 *
 * 只在「库里没有主歌词」时才发起拉取，避免每次播放都打插件接口。
 */
export async function getSongLyric(song: LP.Song): Promise<Result<LP.SongLyric>> {
    const base = await getOrCreateSongLyric(song.id)
    if (!isOk(base)) return base
    if (base.value.lyric) return base

    let fetched: Result<Partial<LP.SongLyric> | null>
    if (song.pluginId === 'local') {
        fetched = ok(await fetchLocalLyric(song))
    } else {
        fetched = await fetchPluginLyric(song)
    }
    if (!isOk(fetched)) return fetched
    if (!fetched.value) return base

    const patch = { ...fetched.value, updatedAt: formatDate() }
    const written = await updateSongLyric(song.id, patch)
    if (!isOk(written)) return written

    return ok({ ...base.value, ...patch })
}
