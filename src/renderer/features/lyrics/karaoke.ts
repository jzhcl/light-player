/**
 * 构建 KRC 行 → LRC 行的索引映射。
 *
 * 前提：KRC 行的 start >= 对应 LRC 行的 time。返回数组第 i 项为 KRC 第 i 行对应的
 * LRC 行索引，-1 表示没配上（通常是间奏或数据不齐）。
 */
export function buildKaraToLrcLineMapping(lrcLines: LyricLine[], krcLines: LP.KrcLine[]): number[] {
    const mapping = new Array<number>(krcLines.length).fill(-1)
    let karaRow = 0

    for (let lrcIndex = 0; lrcIndex < lrcLines.length; lrcIndex++) {
        // 空行（间奏）不参与配对，否则会把空缺行错配给下一段逐字
        if (!lrcLines[lrcIndex].text.trim()) continue

        const lrcTime = lrcLines[lrcIndex].time
        while (karaRow < krcLines.length && krcLines[karaRow].start < lrcTime) karaRow++

        if (karaRow < krcLines.length) {
            mapping[karaRow] = lrcIndex
            karaRow++
        }
    }
    return mapping
}

/** 反向映射：LRC 行 → KRC 行索引，null 表示该行没有对应逐字数据。 */
export function buildLrcToKaraLineMapping(
    lrcLines: LyricLine[],
    krcLines: LP.KrcLine[],
): (number | null)[] {
    const karaToLrc = buildKaraToLrcLineMapping(lrcLines, krcLines)
    const lrcToKara = new Array<number | null>(lrcLines.length).fill(null)

    for (let karaRow = 0; karaRow < krcLines.length; karaRow++) {
        const lrcIndex = karaToLrc[karaRow]
        if (lrcIndex !== -1) lrcToKara[lrcIndex] = karaRow
    }
    return lrcToKara
}

/**
 * 构建 KRC 词 → LRC 字位置的映射。
 *
 * 逐字歌词里一个「词」可能对应 LRC 正文里的多个字符（如 KRC 词 "Elva" 对 LRC 的
 * E-l-v-a），也可能带首尾空格。返回数组第 i 项为 KRC 第 i 行各词在 LRC 正文中的
 * 起始字符下标，-1 表示没对上。
 */
export function buildKaraToLrcWordMapping(
    lrcLines: LyricLine[],
    krcLines: LP.KrcLine[],
    karaToLrcLine: number[],
): number[][] {
    const wordMapping: number[][] = []

    for (let karaRow = 0; karaRow < krcLines.length; karaRow++) {
        const words = krcLines[karaRow].words
        const charMapping = new Array<number>(words.length).fill(-1)
        wordMapping.push(charMapping)

        const lrcIndex = karaToLrcLine[karaRow]
        if (lrcIndex === undefined || lrcIndex === -1) continue

        const lrcText = lrcLines[lrcIndex].text
        let karaWord = 0
        let lrcChar = 0

        while (lrcChar < lrcText.length && karaWord < words.length) {
            const word = words[karaWord].word
            const ch = lrcText[lrcChar]

            if (!ch) {
                lrcChar++
                continue
            }

            // 单词正好等于单字（中文场景的常见情形）
            if (word === ch || word.trim() === ch) {
                charMapping[karaWord] = lrcChar
                karaWord++
                lrcChar++
                continue
            }

            // 多字词：整词匹配
            if (word.length > 1) {
                if (
                    lrcChar + word.length <= lrcText.length &&
                    lrcText.substring(lrcChar, lrcChar + word.length) === word
                ) {
                    charMapping[karaWord] = lrcChar
                    karaWord++
                    lrcChar += word.length
                    continue
                }

                const trimmed = word.trim()
                if (
                    trimmed !== word &&
                    trimmed.length > 0 &&
                    lrcChar + trimmed.length <= lrcText.length &&
                    lrcText.substring(lrcChar, lrcChar + trimmed.length) === trimmed
                ) {
                    charMapping[karaWord] = lrcChar
                    karaWord++
                    lrcChar += trimmed.length
                    continue
                }
            }

            // 空词：不给位置，直接消费掉，避免卡死循环
            if (word === '') {
                charMapping[karaWord] = lrcChar
                karaWord++
                continue
            }

            lrcChar++
        }
    }
    return wordMapping
}
