import type { ParsedLyric } from '@renderer/store'
import { buildKaraToLrcLineMapping, buildKaraToLrcWordMapping, buildLrcToKaraLineMapping } from './karaoke'
import { parseLrc } from './lrc'
import { buildTranslationMapping } from './translation'

/**
 * 把一份库侧歌词记录解析成引擎产物。
 *
 * 纯计算、不碰任何 store——这样它既能在渲染进程里被引擎调用，也能直接被验证脚本
 * 拿去断言（不牵连 zustand 与路径别名）。
 */
export function parseSongLyric(lyric: LP.SongLyric, songId: string): ParsedLyric {
    const { lines: lrcLines, metadata } = parseLrc(lyric.lyric)
    const krcLines = lyric.klyric ?? []
    const hasKara = krcLines.length > 0

    // 三个映射只在有逐字数据时才有意义；无逐字时留空，下游据空数组回退到整行高亮
    const karaToLrcLine = hasKara ? buildKaraToLrcLineMapping(lrcLines, krcLines) : []
    const lrcToKaraLine = hasKara ? buildLrcToKaraLineMapping(lrcLines, krcLines) : []
    const karaToLrcWord = hasKara ? buildKaraToLrcWordMapping(lrcLines, krcLines, karaToLrcLine) : []

    // 翻译行 / 罗马音行都与主歌词行按时间对齐
    const translationLines = lyric.tlyric ? parseLrc(lyric.tlyric).lines : []
    const matchedTranslations = buildTranslationMapping(lrcLines, translationLines)
    const matchedRoma = buildTranslationMapping(lrcLines, readRomaLines(lyric.rlyric))

    const mode: ParsedLyric['mode'] = hasKara ? 'krc' : lrcLines.length ? 'lrc' : 'none'

    return {
        songId,
        mode,
        lrcLines,
        metadata,
        krcLines,
        matchedTranslations,
        matchedRoma,
        karaToLrcLine,
        lrcToKaraLine,
        karaToLrcWord,
    }
}

/**
 * 罗马音可能是 lrc 文本，也可能是与逐字歌词对应的 krc 结构（见 `LP.SongLyric.rlyric`），
 * 这里统一压成「行文本」再对齐 —— 对齐只关心「时间 + 整行文本」。
 */
function readRomaLines(rlyric: LP.SongLyric['rlyric']): LyricLine[] {
    if (!rlyric) return []
    if (typeof rlyric === 'string') return parseLrc(rlyric).lines
    // krc 结构的罗马音：词自带空格（罗马音是分词写的），直接拼接即可
    return rlyric.map((line) => ({ time: line.start, text: line.words.map((w) => w.word).join('') }))
}
