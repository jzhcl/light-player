import { createSongLyric, getSongLyricBySongId, updateSongLyric } from '@renderer/lib/db'
import { parseAudioMetadata, type AudioLyricTag } from '@renderer/lib/audio'
import { readLyricFile } from '@renderer/lib/lyricFile'
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

/** 毫秒 → `mm:ss.xx` */
function formatLrcTime(ms: number): string {
    const cs = Math.max(0, Math.round(ms / 10))
    const m = Math.floor(cs / 6000)
    const s = Math.floor((cs % 6000) / 100)
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`
}

/**
 * 内嵌歌词标签 → 库侧 `lyric`（LRC 文本）。
 *
 *  - mp3 的 USLT 原样保留时间轴，直接取 `text`；
 *  - FLAC / OGG 的 `LYRICS` 是纯字符串，music-metadata 会当成 LRC 解析，
 *    时间轴进 `syncText`、`text` 只剩去掉时间轴的纯文本
 *    （见 music-metadata `lib/lrc/LyricsParser.js`）。
 *    这时必须由 `syncText` 重建，否则时间轴就丢了 —— 而 `lyric` 字段的契约就是 LRC。
 */
function lyricFromTag(tag: AudioLyricTag): string | null {
    if (tag.syncText?.length) {
        return tag.syncText.map(({ timestamp, text }) => `[${formatLrcTime(timestamp)}]${text}`).join('\n')
    }
    return tag.text?.trim() ? tag.text : null
}

/**
 * 本地歌曲：从音频文件的内嵌标签取歌词。
 * 解析失败不阻断：本地文件没内嵌歌词是常态，不是错误。
 */
async function fetchLocalLyric(song: LP.Song): Promise<Partial<LP.SongLyric> | null> {
    const metaR = await parseAudioMetadata(song.pluginSongId)
    if (!isOk(metaR)) return null

    for (const tag of metaR.value.common.lyrics ?? []) {
        const lyric = lyricFromTag(tag)
        if (lyric) return { lyric }
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
 * 下载时落下的歌词文件（`<userData>/download_lyric/`，与音频文件同名）。
 *
 * 本地歌的 `pluginSongId` 就是文件路径；插件歌取任意一个已下载音质的路径 ——
 * 正常情况下插件会给歌词，这里只是「碰运气」的兜底（插件被禁用/删掉时才有意义）。
 */
async function fetchStoredLyric(song: LP.Song): Promise<Partial<LP.SongLyric> | null> {
    const audioPath =
        song.pluginId === 'local' ? song.pluginSongId : song.downloadQualities?.[0]?.path
    if (!audioPath) return null

    const r = await readLyricFile(audioPath)
    if (!isOk(r) || !r.value) return null

    return {
        lyric: r.value.lyric,
        tlyric: r.value.tlyric ?? '',
        klyric: r.value.klyric ?? [],
        rlyric: r.value.rlyric ?? '',
    }
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
        // 先看下载时落下的完整歌词（含逐字 / 翻译 / 罗马音），没有再退回音频文件内嵌的 LRC
        fetched = ok((await fetchStoredLyric(song)) ?? (await fetchLocalLyric(song)))
    } else {
        const r = await fetchPluginLyric(song)
        if (isOk(r) && r.value) {
            fetched = r
        } else {
            // 插件没给（或插件已不可用）→ 翻一下下载时留下的歌词文件；都没有就保留插件的结果
            const stored = await fetchStoredLyric(song)
            fetched = stored ? ok(stored) : r
        }
    }
    if (!isOk(fetched)) return fetched
    if (!fetched.value) return base

    const patch = { ...fetched.value, updatedAt: formatDate() }
    const written = await updateSongLyric(song.id, patch)
    if (!isOk(written)) return written

    return ok({ ...base.value, ...patch })
}
