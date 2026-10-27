/**
 * 按时间把翻译行对到主歌词行上。
 *
 * 两个数组均已按时间升序，用双指针一趟扫完 O(n+m)。每行翻译只消费一次，
 * 避免同一句翻译被重复贴到相邻的两行主歌词上。
 *
 * toleranceMs 允许的时间偏差（毫秒）
 */
export function buildTranslationMapping(
    mainLines: LyricLine[],
    transLines: LyricLine[],
    toleranceMs = 100,
): (string | null)[] {
    const result = new Array<string | null>(mainLines.length).fill(null)
    if (!transLines.length) return result

    let transIdx = 0
    for (let i = 0; i < mainLines.length; i++) {
        const mainTime = mainLines[i].time

        // 跳过明显早于本行的翻译行
        while (transIdx < transLines.length && transLines[transIdx].time < mainTime - toleranceMs) {
            transIdx++
        }

        if (transIdx < transLines.length && Math.abs(transLines[transIdx].time - mainTime) <= toleranceMs) {
            result[i] = transLines[transIdx].text || null
            transIdx++ // 消费掉，避免重复匹配
        }
    }
    return result
}
