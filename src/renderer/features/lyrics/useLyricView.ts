import { useCallback, useMemo } from 'react'
import { useLyricsStore } from '@renderer/store'
import { player } from '@renderer/features/player/player'
import { buildDisplayLines } from './displayLines'

/**
 * 歌词渲染内核：把解析产物整理成「渲染层直接可用」的形状。
 *
 * 这里只有低频数据（切歌、换行、翻译）。逐字进度是 60fps 的高频量，不从这里出——
 * 由真正在渲染当前行的组件自己起 rAF、按 karaokeClock 算（见渲染层的逐字行）。所以本
 * hook 挂在常驻组件（例如底栏预览）上也不产生任何高频开销。
 */

interface LyricView {
    /** 有效歌词形态；none 时应显示「暂无歌词」 */
    mode: 'none' | 'lrc' | 'krc'
    /** 显示行 */
    lines: LyricDisplayLine[]
    /** 当前行下标（显示行索引）；-1 表示尚未进入任何行 */
    activeIndex: number
    /** 点某一行跳到该行开头 */
    seekToLine: (index: number) => void
}

export function useLyricView(): LyricView {
    const mode = useLyricsStore((s) => s.mode)
    const lrcLines = useLyricsStore((s) => s.lrcLines)
    const krcLines = useLyricsStore((s) => s.krcLines)
    const matchedTranslations = useLyricsStore((s) => s.matchedTranslations)
    const matchedRoma = useLyricsStore((s) => s.matchedRoma)
    const karaToLrcLine = useLyricsStore((s) => s.karaToLrcLine)
    const activeIndex = useLyricsStore((s) => s.lineIndex)

    // 只在歌词本体变化时重建。行级切换不会走到这里（那只是个下标），
    // 所以每一行的元素引用在整首歌内保持稳定，不会频繁重挂。
    const lines = useMemo(
        () => buildDisplayLines({ mode, lrcLines, krcLines, matchedTranslations, matchedRoma, karaToLrcLine }),
        [mode, lrcLines, krcLines, matchedTranslations, matchedRoma, karaToLrcLine],
    )

    const seekToLine = useCallback(
        (index: number) => {
            const line = lines[index]
            if (line) player.seekTo(line.time / 1000)
        },
        [lines],
    )

    return { mode, lines, activeIndex, seekToLine }
}
