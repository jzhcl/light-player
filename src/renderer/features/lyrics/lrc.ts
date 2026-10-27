/** 头部标签：[ti:标题] [ar:歌手] [offset:-500]。key 为纯字母，天然不与时间标签冲突。 */
const META_TAG = /\[([a-zA-Z]+):([^\]]*)]/g
/** 时间标签：[mm:ss.xx] / [mm:ss.xxx] / [mm:ss]；同一行可重复出现，表示该行复用多次。 */
const TIME_TAG = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{2,3}))?]/g
/** 剥掉行内所有方括号标签，剩下的才是歌词正文 */
const ANY_TAG = /\[[^\]]*]/g

function toMs(min: string, sec: string, frac?: string): number {
    // 两位小数是厘秒（×10 得毫秒），三位即毫秒
    const fracMs = frac ? parseInt(frac, 10) * (frac.length === 3 ? 1 : 10) : 0
    return parseInt(min, 10) * 60000 + parseInt(sec, 10) * 1000 + fracMs
}

/**
 * 解析 LRC 文本。
 *
 * 空文本行保留不丢弃——它代表间奏，UI 侧需要它来占位。
 */
export function parseLrc(text: string): { lines: LyricLine[]; metadata: LrcMetadata } {
    const metadata: LrcMetadata = { offset: 0 }
    if (!text) return { lines: [], metadata }

    for (const m of text.matchAll(META_TAG)) {
        const key = m[1].toLowerCase()
        const value = m[2].trim()
        if (key === 'offset') {
            const n = Number(value)
            metadata.offset = Number.isFinite(n) ? n : 0
        } else {
            metadata[key] = value
        }
    }

    const { offset } = metadata
    const lines: LyricLine[] = []
    for (const raw of text.split('\n')) {
        const content = raw.replace(ANY_TAG, '').trim()
        for (const m of raw.matchAll(TIME_TAG)) {
            lines.push({ time: toMs(m[1], m[2], m[3]) - offset, text: content })
        }
    }
    lines.sort((a, b) => a.time - b.time)

    return { lines, metadata }
}
