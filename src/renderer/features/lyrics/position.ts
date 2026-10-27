/** 一个 KRC 词的结束时间：优先用 end，缺失时才退到 start + duration。 */
export const wordEnd = (w: LP.KrcLine['words'][number]): number => w.end ?? w.start + (w.duration ?? 0)

/**
 * 求「最后一个 time <= tMs」的行索引，早于首行时返回 -1。
 */
export function findLrcLineIndex(lines: LyricLine[], tMs: number): number {
    if (!lines.length) return -1

    let lo = 0
    let hi = lines.length - 1
    let ans = -1
    while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (lines[mid].time <= tMs) {
            ans = mid
            lo = mid + 1
        } else {
            hi = mid - 1
        }
    }
    return ans
}

/**
 * 把「按时间求得的行索引」解析成「应作为当前行显示的行索引」。
 *
 * 间奏（无词空行）不能让单行显示层空着、也不能掉回歌名，按三个分支分流：
 * - 前有词、后有词 → 前移到下一句（间奏时提前预告下一行）
 * - 前无词（引子间奏）→ 返回 -1，交由调用方兜底（桌面歌词显示歌名）
 * - 前有词、后无词（末尾间奏）→ 回退到前一句，即全曲最后一句
 *
 * 非空行原样返回；`lineIndex < 0`（还没到首行）保持 -1。返回的索引必然落在有词的行上。
 */
export function resolveActiveLineIndex(lines: LyricDisplayLine[], lineIndex: number): number {
    if (lineIndex < 0 || lineIndex >= lines.length) return -1
    if (lines[lineIndex].text.trim()) return lineIndex

    // 当前是间奏空行：分别找前后最近的有词行
    let prev = -1
    for (let i = lineIndex - 1; i >= 0; i--) {
        if (lines[i].text.trim()) {
            prev = i
            break
        }
    }
    if (prev < 0) return -1 // 前面没词（引子）→ 交给调用方兜底

    for (let i = lineIndex + 1; i < lines.length; i++) {
        if (lines[i].text.trim()) return i // 后面有词 → 提前显示下一句
    }
    return prev // 后面没词（末尾间奏）→ 保持最后一句
}

/**
 * 展示的那一行是不是「还没开唱的下一句预告」——决定要不要点亮它。
 *
 * 位置与高亮是两件事，分开算：`resolveActiveLineIndex` 管显示哪一行，
 * 这里管那一行该不该用「已唱」色。间奏时位置被前移到了下一句（`shown > lineIndex`）——
 * 那一句还没唱到，点亮它就会出现「下句在间奏里就亮了」的假象。判据是比较显示位置与
 * 时间位置：前移（预告）→ true 不点亮；原地（正在唱）与回退（末尾间奏保持的最后一句，
 * 已经唱过）→ false 照常点亮；曲名兜底（-1）→ false 常亮。
 */
export function isPendingLine(lines: LyricDisplayLine[], lineIndex: number): boolean {
    return resolveActiveLineIndex(lines, lineIndex) > lineIndex
}

/**
 * 行索引 + 行内字符位置 + 当前词进度（逐字模式用）。
 * 没有逐字数据时 charIndex / progress 为 -1，调用方据此回退到整行高亮。
 */
export function findLrcLineIndexWithCharIndex(
    lines: LyricLine[],
    krcLines: LP.KrcLine[],
    lrcToKaraLine: (number | null)[],
    karaToLrcWord: number[][],
    tMs: number,
): { lineIndex: number; charIndex: number; progress: number } {
    const lineIndex = findLrcLineIndex(lines, tMs)
    const noKara = { lineIndex, charIndex: -1, progress: -1 }
    if (lineIndex === -1 || !krcLines.length) return noKara

    const karaRow = lrcToKaraLine[lineIndex]
    if (karaRow === null || karaRow === undefined) return noKara

    const karaLine = krcLines[karaRow]
    let wordIndex = -1
    let wordProgress = -1
    for (let i = 0; i < karaLine.words.length; i++) {
        const w = karaLine.words[i]
        const end = wordEnd(w)
        if (tMs >= w.start && tMs <= end) {
            wordIndex = i
            wordProgress = end - w.start > 0 ? (tMs - w.start) / (end - w.start) : 0
            break
        }
    }

    // 没落在任何词内（行首空隙 / 行尾空档）→ 从行首开始
    if (wordIndex === -1) return { lineIndex, charIndex: 0, progress: 0 }

    const charIndex = karaToLrcWord[karaRow]?.[wordIndex] ?? 0
    const wordLength = karaLine.words[wordIndex].word.length
    const completedChars = Math.floor(wordLength * wordProgress)

    return { lineIndex, charIndex: charIndex + completedChars, progress: wordProgress }
}

/**
 * 求「最后一个 start <= tMs」的 KRC 行索引，早于首行时返回 -1。
 *
 * 逐字歌词是自己的一排行：行数、时间、索引空间都可能和 LRC 对不上。
 * 所以逐字模式下要另算一套行索引，别再拿 LRC 的索引去映射。
 */
export function findKrcLineIndex(krcLines: LP.KrcLine[], tMs: number): number {
    for (let i = krcLines.length - 1; i >= 0; i--) {
        if (tMs >= krcLines[i].start) return i
    }
    return -1
}

/**
 * 直接在 KRC 行/词结构上算出当前播放位置。
 * KRC 自带逐字时间，不必先映射回 LRC，逐字模式下这条路径更直接。
 */
export function findKrcState(krcLines: LP.KrcLine[], tMs: number): LyricState {
    const lineIndex = findKrcLineIndex(krcLines, tMs)
    if (lineIndex === -1) return { lineIndex: -1, wordIndex: -1, progress: 0 }

    const line = krcLines[lineIndex]
    let wordIndex = -1
    let progress = 0
    for (let i = 0; i < line.words.length; i++) {
        const w = line.words[i]
        const end = wordEnd(w)
        if (tMs >= w.start && tMs < end) {
            wordIndex = i
            const dur = end - w.start
            progress = dur > 0 ? (tMs - w.start) / dur : 0
            break
        }
        if (tMs >= end) {
            wordIndex = i
            progress = 1
        }
    }

    return { lineIndex, wordIndex, progress: Math.min(1, Math.max(0, progress)) }
}
