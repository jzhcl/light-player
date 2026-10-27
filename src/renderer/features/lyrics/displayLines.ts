import type { ParsedLyric } from '@renderer/store'
import { wordEnd } from './position'

/**
 * 把解析产物压成渲染层要的「显示行」。
 *
 * 为什么要这一步：LRC 行与 KRC 行是两套东西——行数、时间、索引空间都可能对不上
 * （KRC 自带绝对时间，LRC 的 offset 不平移它，见 NOTES）。
 * 这里把它收敛成一个纯函数：调用方拿到的是同一形状的数组，不必知道当前是什么模式。
 */

/** 不需要靠空格分词的文字：CJK / 假名 / 谚文 / 全角标点。 */
const CJK_REGEX = /[\u3040-\u309F\u30A0-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF]/

/**
 * 相邻两词之间是否需要补一个空格。
 *
 * KRC 的词切分不带分隔空白（英文是逐词切开的），直接拼接会让单词粘连；
 * 而中日韩文字之间本来就不该有空格，所以只在「两侧都不是 CJK」时才补。
 */
function needsSpaceBetween(cur: string, next: string): boolean {
    // 词里已经带了分隔空白就不重复添加
    if (/\s$/.test(cur) || /^\s/.test(next)) return false

    const curTrim = cur.replace(/\s+$/, '')
    const nextTrim = next.replace(/^\s+/, '')
    if (!curTrim || !nextTrim) return false

    return !CJK_REGEX.test(curTrim.slice(-1)) && !CJK_REGEX.test(nextTrim[0])
}

/** buildDisplayLines 的入参：只需要解析产物里与「显示」有关的那几项。 */
type DisplayLineSource = Pick<
    ParsedLyric,
    'mode' | 'lrcLines' | 'krcLines' | 'matchedTranslations' | 'matchedRoma' | 'karaToLrcLine'
>

function buildFromLrc(src: DisplayLineSource): LyricDisplayLine[] {
    return src.lrcLines.map((line, i) => ({
        time: line.time,
        text: line.text,
        translation: src.matchedTranslations[i] ?? null,
        roma: src.matchedRoma[i] ?? null,
        words: null,
    }))
}

function buildFromKrc(src: DisplayLineSource): LyricDisplayLine[] {
    return src.krcLines.map((line, i) => {
        // 翻译 / 罗马音都是按 LRC 行对齐的，KRC 行要经映射反查
        const lrcIndex = src.karaToLrcLine[i]
        const matched = lrcIndex === undefined || lrcIndex < 0
        const translation = matched ? null : src.matchedTranslations[lrcIndex] ?? null
        const roma = matched ? null : src.matchedRoma[lrcIndex] ?? null

        const rawWords = line.words ?? []
        // 纯空白行（间奏）：保留占位行参与滚动，但不逐字
        if (!rawWords.some((w) => w.word.trim() !== '')) {
            return { time: line.start, text: '', translation, roma, words: null }
        }

        // 词间空格必须补在「词自己身上」，不能只补进拼接后的整行文本：
        // 当前行是逐词渲染的（每词两层文本 + 裁剪），只改整行 text 的话当前行看不见空格，
        // 切走的那一刻空格又冒出来——英文歌会看到单词先粘连、再分开。
        const words: LyricWordSeg[] = rawWords.map((w) => ({
            text: w.word,
            start: w.start,
            end: wordEnd(w),
        }))
        for (let k = 0; k < words.length - 1; k++) {
            if (needsSpaceBetween(rawWords[k].word, rawWords[k + 1].word)) words[k].text += ' '
        }

        return {
            time: line.start,
            text: words.map((w) => w.text).join(''),
            translation,
            roma,
            words,
        }
    })
}

/** 逐字可用时以 KRC 行为准，否则退回 LRC 行；都没有就是空数组。 */
export function buildDisplayLines(src: DisplayLineSource): LyricDisplayLine[] {
    if (src.mode === 'krc') return buildFromKrc(src)
    if (src.mode === 'lrc') return buildFromLrc(src)
    return []
}
