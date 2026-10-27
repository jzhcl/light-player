import { useMemo } from 'react'
import { KaraokeLine } from '@renderer/features/lyrics/KaraokeLine'
import { isPendingLine, resolveActiveLineIndex } from '@renderer/features/lyrics/position'
import { useLyricWindowStore } from '../store'

interface LyricViewProps {
    /** 显示行：与主窗同一个纯函数压出来的产物 */
    lines: LyricDisplayLine[]
    /** 按时间求得的当前行索引；-1 = 还没唱到第一句 */
    lineIndex: number
    isPlaying: boolean
    /** 曲名：无歌词 / 还没唱到第一句时的兜底文案，别让整窗空白 */
    songName: string
}

/**
 * 歌词内容：三种形态由设置决定 ——
 * 单行（恒居中）/ 双行居中 / 双行左右分离。
 */
export function LyricView({ lines, lineIndex, isPlaying, songName }: LyricViewProps) {
    const settings = useLyricWindowStore((s) => s.settings)

    // 「显示序」：去掉空行（间奏）后重新编号。配对与左右交替都在这个序里做，
    // 否则每过一个间奏空行，两侧就会来回翻一次。
    const order = useMemo(() => {
        let n = -1
        return lines.map((l) => (l.text.trim() ? ++n : -1))
    }, [lines])

    /** 可显示的行（非空） */
    const visible = useMemo(() => lines.filter((l) => l.text.trim() !== ''), [lines])

    /** 应当显示的行：间奏前移到下一句 / 末尾回退到前一句，引子（前无词）与曲名兜底为 -1 */
    const shown = useMemo(() => resolveActiveLineIndex(lines, lineIndex), [lines, lineIndex])

    /** 显示的这一行是否「还没开唱」（间奏前移出来的预告行）→ 不点亮 */
    const pending = useMemo(() => isPendingLine(lines, lineIndex), [lines, lineIndex])

    /** 当前行落在显示序里的位置 */
    const cur = shown < 0 ? -1 : order[shown]

    // 设置整包还没到（首帧快照在路上）→ 什么都不画：这会儿连歌词也还没到。
    // ⚠️ 这个提前 return 必须在所有 hook 之后 —— 放在 hook 前面会让两次渲染的
    // hook 数量不一致（首次 return null 少跑几个 useMemo），React 当场抛错。
    if (!settings) return null

    const { lineCount, align, secondaryLine } = settings
    // 单行没有「左右」可分
    const alternate = lineCount === 2 && align === 'alternate'

    // 整首都没有可显示的行 → 只留一句兜底
    if (!visible.length) {
        return <div className="lyric-line is-current">{songName || 'LightPlayer'}</div>
    }

    const current = shown >= 0 ? lines[shown] : undefined
    /** 展示的当前行本身有词可显示吗（只有曲名兜底时为 false） */
    const hasCurrent = !!current?.text.trim()
    /**
     * 辅助行的文本：设置选「翻译」就取翻译、选「罗马音」就取罗马音、选「不显示」恒为空。
     * 空串一律当没有 —— 歌词里空占位是常态，渲染出来只会多一行空白。
     */
    const secondaryOf = (line: LyricDisplayLine | undefined): string | null => {
        if (!line || secondaryLine === 'none') return null
        const text = secondaryLine === 'translation' ? line.translation : line.roma
        return text || null
    }

    if (!alternate) {
        // 双行时下一句照常显示（`cur` 已经落在显示序上，引子时即第一句）
        const next = visible[cur + 1]
        return (
            <>
                {/* 预告行还没开唱：整行按「未唱」色画，也不逐字 —— 等它真成了当前行再揭幕 */}
                <div className={`lyric-line ${pending ? 'is-next' : 'is-current'}`}>
                    {/* 有逐字数据就逐字揭幕；没有（LRC 模式）退回整行文本，
                        再没有（还没唱到第一句）就显示曲名，避免整窗空白 */}
                    {hasCurrent && !pending && current?.words ? (
                        /* follow：溢出时让正在唱的词停在视口中心 —— 桌面歌词窗特有的口径 */
                        <KaraokeLine words={current.words} isPlaying={isPlaying} follow/>
                    ) : (
                        (hasCurrent ? current?.text : '') || songName || 'LightPlayer'
                    )}
                </div>
                {hasCurrent && secondaryOf(current) ? (
                    <div className={`lyric-secondary ${pending ? 'is-next' : 'is-current'}`}>
                        {secondaryOf(current)}
                    </div>
                ) : null}
                {lineCount === 2 && next?.text ? (
                    <div className="lyric-line is-next">{next.text}</div>
                ) : null}
            </>
        )
    }

    // 左右分离：当前句在左（显示序偶数）还是右（奇数）—— 与配色无关，只决定怎么配对。
    // 高亮另算：预告行（间奏前移出来的下一句）两侧都不点亮。
    const curOnLeft = cur < 0 || cur % 2 === 0
    const leftOrder = cur < 0 ? 0 : curOnLeft ? cur : cur + 1 < visible.length ? cur + 1 : cur - 1
    const rightOrder = cur < 0 ? 1 : curOnLeft ? cur + 1 : cur
    const left = visible[leftOrder]
    const right = visible[rightOrder]
    const leftLit = !pending && curOnLeft
    const rightLit = !pending && !curOnLeft

    return (
        <>
            <Row line={left} side="left" active={leftLit} isPlaying={isPlaying}/>
            {secondaryOf(left) ? (
                <div className={`lyric-secondary ${leftLit ? 'is-current' : 'is-next'} is-left`}>
                    {secondaryOf(left)}
                </div>
            ) : null}
            <Row line={right} side="right" active={rightLit} isPlaying={isPlaying}/>
            {secondaryOf(right) ? (
                <div className={`lyric-secondary ${rightLit ? 'is-current' : 'is-next'} is-right`}>
                    {secondaryOf(right)}
                </div>
            ) : null}
        </>
    )
}

interface RowProps {
    line: LyricDisplayLine | undefined
    side: 'left' | 'right'
    /** 是否为「已唱句」：决定配色，也决定要不要逐字（待唱的预告行不给逐字） */
    active: boolean
    isPlaying: boolean
}

function Row({ line, side, active, isPlaying }: RowProps) {
    if (!line) return null

    const className = ['lyric-line', active ? 'is-current' : 'is-next', `is-${side}`].join(' ')

    return (
        <div className={className}>
            {/* 逐字只给当前句：非当前句按整行文本画，
                顺带避开「已经唱过的下一句被整行高亮」这种怪相。
                follow：这一层只会画「已唱的那一侧」，所以只有当前行会跟随。 */}
            {active && line.words ? (
                <KaraokeLine words={line.words} isPlaying={isPlaying} follow/>
            ) : (
                line.text
            )}
        </div>
    )
}
