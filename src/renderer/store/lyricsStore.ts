import { create } from 'zustand'

/**
 * 一首歌解析后的全部歌词产物
 */
export interface ParsedLyric {
    /** 解析产物对应的歌曲 id；空串表示尚未解析 */
    songId: string
    /** 有效歌词形态：有逐字用 krc，否则有 LRC 用 lrc，都没有为 none */
    mode: 'none' | 'lrc' | 'krc'
    lrcLines: LyricLine[]
    metadata: LrcMetadata
    krcLines: LP.KrcLine[]
    /** 与 lrcLines 等长对齐的翻译文本 */
    matchedTranslations: (string | null)[]
    /** 与 lrcLines 等长对齐的罗马音文本 */
    matchedRoma: (string | null)[]
    /** KRC 行 → LRC 行索引 */
    karaToLrcLine: number[]
    /** LRC 行 → KRC 行索引 */
    lrcToKaraLine: (number | null)[]
    /** KRC 词 → LRC 正文起始字符下标 */
    karaToLrcWord: number[][]
}

const EMPTY_PARSED: ParsedLyric = {
    songId: '',
    mode: 'none',
    lrcLines: [],
    metadata: { offset: 0 },
    krcLines: [],
    matchedTranslations: [],
    matchedRoma: [],
    karaToLrcLine: [],
    lrcToKaraLine: [],
    karaToLrcWord: [],
}

type LyricsState = ParsedLyric & {
    /** 当前行索引（低频，引擎在 currentTime 变化时写入）；-1 表示尚未进入任何行 */
    lineIndex: number
    setParsed: (parsed: ParsedLyric) => void
    setLineIndex: (lineIndex: number) => void
    reset: () => void
}

export const useLyricsStore = create<LyricsState>((set) => ({
    ...EMPTY_PARSED,
    lineIndex: -1,
    setParsed: (parsed) => set({ ...parsed, lineIndex: -1 }),
    setLineIndex: (lineIndex) => set({ lineIndex }),
    reset: () => set({ ...EMPTY_PARSED, lineIndex: -1 }),
}))
