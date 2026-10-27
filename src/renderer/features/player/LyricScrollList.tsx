import { useRef } from 'react'
import { usePlayerStore } from '@renderer/store'
import { KaraokeLine } from '@renderer/features/lyrics/KaraokeLine'
import { useLyricView } from '@renderer/features/lyrics/useLyricView'
import { useLyricAutoScroll } from './useLyricAutoScroll'

/**
 * 歌词列表渲染策略。
 *
 * 只做「把内核给的显示行排成一份可滚动的列表」：LRC 整行高亮、KRC 逐字展开、翻译行、
 * 点行跳转、自动居中。与列表无关的东西（数据从哪来、哪种模式、索引怎么算）一律不在这里。
 *
 * 每行带 `data-d` = 与当前行的距离（钳在 3）。样式侧按距离做
 * 「字号 + 亮度」双重递减（取自样例 ref3）。刻意不在这里算字号：列表只给数据。
 * ⚠️ 递减用 `transform: scale()` 而不是 `font-size`：后者会改变行高，
 * 当前行一动整个列表就跟着回流、自动居中的锚点也会抖。
 */

/** 距离超过这个值就不再细分（更远的行长得一样，省掉无意义的选择器分支） */
const MAX_DISTANCE = 3

export function LyricScrollList() {
    const { mode, lines, activeIndex, seekToLine } = useLyricView()
    const isPlaying = usePlayerStore((s) => s.state === 'playing')
    const songId = usePlayerStore((s) => s.currentSong?.id ?? '')

    const scrollRef = useRef<HTMLDivElement | null>(null)
    const lineRefs = useRef<(HTMLDivElement | null)[]>([])

    const { onWheel, onMouseLeave } = useLyricAutoScroll({
        scrollRef,
        lineRefs,
        activeIndex,
        total: lines.length,
        isPlaying,
        resetKey: songId,
    })

    if (mode === 'none') {
        return (
            <div className="play-lyric play-lyric--empty">
                <span>暂无歌词</span>
            </div>
        )
    }

    return (
        <div className="play-lyric" ref={scrollRef} onWheel={onWheel} onMouseLeave={onMouseLeave}>
            {/* 上下留白：让首行与末行都能停到锚点高度 */}
            <div className="play-lyric-spacer play-lyric-spacer--top"/>

            {lines.map((line, i) => (
                <div
                    key={i}
                    ref={(el) => {
                        lineRefs.current[i] = el
                    }}
                    className={`play-lyric-line${i === activeIndex ? ' is-active' : ''}`}
                    data-d={Math.min(Math.abs(i - activeIndex), MAX_DISTANCE)}
                    onClick={() => seekToLine(i)}
                >
                    {line.words && i === activeIndex ? (
                        <KaraokeLine words={line.words} isPlaying={isPlaying}/>
                    ) : (
                        // 无词行用全角空格占位，保住行高，也让它能被点到（间奏也要能跳）
                        <span className="play-lyric-text">{line.text || '\u3000'}</span>
                    )}

                    {line.translation ? <p className="play-lyric-translation">{line.translation}</p> : null}
                </div>
            ))}

            <div className="play-lyric-spacer play-lyric-spacer--bottom"/>
        </div>
    )
}
