import { useEffect } from 'react'
import { buildDisplayLines } from '@renderer/features/lyrics/displayLines'
import { getKaraokeTimeMs } from '@renderer/features/lyrics/karaokeClock'
import { isPendingLine, resolveActiveLineIndex } from '@renderer/features/lyrics/position'
import { useLyricsStore, usePlayerStore, useSettingsStore } from '@renderer/store'
import { invoke } from '@renderer/lib/ipc'
import { IS_MAC } from '@renderer/lib/constants'

/**
 * 菜单栏歌词（macOS）：在渲染端把当前行画成一张位图，交给主进程 `tray.setImage`。
 *
 * 配色取自桌面歌词的配色方案（已唱 = 高亮层，未唱 = 底色），并且是快照式的：
 * 只在「打开菜单栏歌词」那一刻读一次，之后改桌面歌词配色不会热更新 ——
 * 要换色必须把这个开关关掉再打开。
 *
 * 采样是按需的：
 * - 有逐字数据 + 正在唱 + 正在播放 → 30Hz 连续推进（字内裁剪要连续才顺）；
 * - 其余（无歌词 / LRC 无逐字 / 暂停）→ 不起定时器，只在歌词行或播放态变化时出一次图。
 */

/** 逐字推进的采样节拍（毫秒） */
const TICK_MS = 33

/** 位图 Retina 倍率，与主进程 `BAR_IMAGE_SCALE` 必须一致 */
const SCALE = 2

/** 菜单栏项逻辑高度（pt） */
const BAR_HEIGHT = 22

/** 位图逻辑宽度（pt）。固定值 = 状态栏项宽度固定 = 图标永不被推挤 */
const BAR_WIDTH = 240

/** 文字两侧留白（pt），超宽时按这个边界截断 */
const PAD = 8

/** 字号（pt）：对齐系统菜单栏 */
const FONT_SIZE = 13

/** 文字视觉中线（pt）：比几何中心略低，跟系统状态栏文字对齐 */
const TEXT_Y = BAR_HEIGHT / 2 + 0.5

/** 设置里读不到配色时的兜底（= `settingsStore` 的「渐变紫」默认值） */
const PALETTE_FALLBACK = { played: '#B24BF3', unplayed: '#E0C3FC' }

const FONT_STACK = `${FONT_SIZE}px -apple-system, "PingFang SC", "Helvetica Neue", sans-serif`

/** 一个词的几何：`x` / `w` 单位都是 pt，相对文字左边缘 */
interface WordBox {
    x: number
    w: number
    start: number
    end: number
}

/** 待绘制的一行 */
interface BarLine {
    /** 截断后的显示文本 */
    text: string
    /** 显示宽度（pt） */
    textWidth: number
    /** 文字左边缘在画布里的 x（居中算出来的） */
    textX: number
    /** 逐词几何；null = 没有逐字数据（LRC），点亮时整行一起亮 */
    boxes: WordBox[] | null
    /** 是否点亮：间奏前移出来的预告行、歌名兜底都是 false */
    lit: boolean
}

export function useTrayLyric(): void {
    const enabled = useSettingsStore((s) => s.settings['appearance.menuBar.showLyric'])

    useEffect(() => {
        // 平台守卫：菜单栏歌词只有 macOS 有
        if (!IS_MAC) return

        // 关掉时把位图收回：主进程会顺带销毁那个状态栏项，菜单栏只剩图标
        if (!enabled) {
            void invoke('tray:lyricImage', null)
            return
        }

        // 配色快照：取一次就定下来，不订阅设置
        const palette = useSettingsStore.getState().settings['desktopLyric.colorPalette']
        const colorPlayed = palette?.played || PALETTE_FALLBACK.played
        const colorUnplayed = palette?.unplayed || PALETTE_FALLBACK.unplayed

        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if (!ctx) return

        /** displayLines 缓存：歌词本体没换就不重建 */
        let lines: LyricDisplayLine[] = []
        let linesKey: readonly unknown[] = []

        /** 上一次画出来的内容指纹，用来跳过重复编码 + IPC */
        let lastSig = ''

        /** 逐字推进用的定时器；不需要推进时必须是 null */
        let timer: number | null = null

        /** layout 结果缓存：同一行的几何只量一次 */
        let cachedLine: BarLine | null = null
        let cachedText = ''
        let cachedWords: LyricWordSeg[] | null = null
        let cachedLit = false

        const rebuild = (): void => {
            const s = useLyricsStore.getState()
            const key = [
                s.mode,
                s.lrcLines,
                s.krcLines,
                s.matchedTranslations,
                s.matchedRoma,
                s.karaToLrcLine,
            ] as const
            if (key.every((v, i) => v === linesKey[i])) return

            linesKey = key
            lines = buildDisplayLines({
                mode: s.mode,
                lrcLines: s.lrcLines,
                krcLines: s.krcLines,
                matchedTranslations: s.matchedTranslations,
                matchedRoma: s.matchedRoma,
                karaToLrcLine: s.karaToLrcLine,
            })
        }

        /** 画布度量：只在行文本变化时调用 */
        const measure = (text: string, words: LyricWordSeg[] | null, lit: boolean): BarLine => {
            ctx.font = FONT_STACK
            const limit = BAR_WIDTH - PAD * 2

            // 超宽截断：二分找能放下的最长前缀，尾巴补省略号
            let shown = text
            let textWidth = ctx.measureText(text).width
            if (textWidth > limit) {
                const ell = ctx.measureText('…').width
                let lo = 0
                let hi = text.length
                while (lo < hi) {
                    const mid = (lo + hi + 1) >> 1
                    if (ctx.measureText(text.slice(0, mid)).width + ell <= limit) lo = mid
                    else hi = mid - 1
                }
                shown = `${text.slice(0, lo)}…`
                textWidth = ctx.measureText(shown).width
            }

            // 逐词几何用「前缀差」量：单词宽度之和会因为字距对不上整行宽度，
            // 而裁剪是按整行像素走的，错一点就会在词边界上看到接缝。
            // 无逐字数据（LRC）时必须是 null 而不是空数组 —— 空数组在上层会被
            // 当成「有逐字」而白开一个 30Hz 定时器。
            let boxes: WordBox[] | null = null
            if (words?.length) {
                boxes = []
                let acc = ''
                let prev = 0
                for (const w of words) {
                    acc += w.text
                    const end = ctx.measureText(acc).width
                    boxes.push({ x: prev, w: end - prev, start: w.start, end: w.end })
                    prev = end
                }
            }

            // 居中：对齐到 1/SCALE 网格，避免文字落在半个物理像素上发虚
            const raw = (BAR_WIDTH - textWidth) / 2
            const textX = Math.round(raw * SCALE) / SCALE

            return { text: shown, textWidth, textX, boxes, lit }
        }

        const layout = (text: string, words: LyricWordSeg[] | null, lit: boolean): BarLine => {
            if (cachedLine && cachedText === text && cachedWords === words && cachedLit === lit) {
                return cachedLine
            }
            cachedText = text
            cachedWords = words
            cachedLit = lit
            cachedLine = measure(text, words, lit)
            return cachedLine
        }

        /** 当前该「唱到第几像素」（pt，相对文字左边缘） */
        const cutWidth = (line: BarLine, tMs: number): number => {
            if (!line.lit) return 0
            // 没有逐字数据（LRC）：正在唱这句 = 整行点亮
            if (!line.boxes) return line.textWidth

            let cut = line.textWidth
            for (const box of line.boxes) {
                if (tMs >= box.end) continue
                if (tMs <= box.start) {
                    cut = box.x
                    break
                }
                const span = box.end - box.start
                const ratio = span > 0 ? (tMs - box.start) / span : 1
                cut = box.x + box.w * ratio
                break
            }
            // 截断后行尾的字看不见，进度夹在可视范围内
            return Math.min(cut, line.textWidth)
        }

        /** 取当前该显示的那一行；没有歌词就退回歌名（整行不点亮） */
        const pickLine = (): { text: string; words: LyricWordSeg[] | null; lit: boolean } => {
            rebuild()

            const s = useLyricsStore.getState()
            if (lines.length) {
                // 间奏时前移到下一句、引子时返回 -1 —— 与桌面歌词窗同一套显示口径
                const shown = resolveActiveLineIndex(lines, s.lineIndex)
                if (shown >= 0) {
                    const line = lines[shown]
                    if (line.text.trim()) {
                        return {
                            text: line.text,
                            words: line.words,
                            lit: !isPendingLine(lines, s.lineIndex),
                        }
                    }
                }
            }

            const song = usePlayerStore.getState().currentSong
            return { text: song?.name ?? '', words: null, lit: false }
        }

        /** 时间基准：与 KaraokeLine 同一套口径 */
        const nowMs = (): number => {
            const actual = usePlayerStore.getState().currentTime * 1000
            const predicted = getKaraokeTimeMs()
            // karaokeClock 可能停在旧值（暂停 / 尚未校准），偏差过大就退回播放器时间
            return Math.abs(predicted - actual) > 1000 ? actual : predicted
        }

        const paint = (line: BarLine, cut: number): void => {
            const wPx = BAR_WIDTH * SCALE
            const hPx = BAR_HEIGHT * SCALE

            // 宽度固定，画布只在首次（或倍率变化）时初始化一次
            if (canvas.width !== wPx || canvas.height !== hPx) {
                canvas.width = wPx
                canvas.height = hPx
                ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0)
                ctx.font = FONT_STACK
                ctx.textBaseline = 'middle'
            } else {
                ctx.clearRect(0, 0, BAR_WIDTH, BAR_HEIGHT)
            }

            const x = line.textX
            const y = TEXT_Y

            // 底色 = 桌面歌词的「未唱」色，与歌词窗同一套配色
            ctx.fillStyle = colorUnplayed
            ctx.fillText(line.text, x, y)

            if (cut <= 0) return

            // 点亮层：整行再画一遍，只把 [x, x+cut] 这段裁出来；颜色 = 「已唱」色
            ctx.save()
            ctx.beginPath()
            ctx.rect(x, 0, cut, BAR_HEIGHT)
            ctx.clip()
            ctx.fillStyle = colorPlayed
            ctx.fillText(line.text, x, y)
            ctx.restore()
        }

        /** 按需启停逐字采样：不需要推进时绝不留一个空转的 30Hz 定时器 */
        function syncTimer(need: boolean): void {
            if (need && timer === null) {
                timer = window.setInterval(tick, TICK_MS)
            } else if (!need && timer !== null) {
                window.clearInterval(timer)
                timer = null
            }
        }

        function tick(): void {
            const { text, words, lit } = pickLine()

            if (!text) {
                syncTimer(false)
                if (lastSig === '') return
                lastSig = ''
                void invoke('tray:lyricImage', null)
                return
            }

            const line = layout(text, words, lit)

            // 只有「有逐字数据 + 正在唱 + 播放中」三个条件同时成立才需要连续推进。
            // LRC 整行点亮是一次跳变，暂停后进度冻结，都不需要 30Hz。
            const playing = usePlayerStore.getState().state === 'playing'
            syncTimer(line.lit && line.boxes !== null && playing)

            const cut = cutWidth(line, nowMs())

            // 配色在这一轮 effect 内是常量，不必进指纹
            const sig = `${line.text}|${cut.toFixed(1)}`
            if (sig === lastSig) return
            lastSig = sig

            paint(line, cut)
            void invoke('tray:lyricImage', canvas.toDataURL('image/png'))
        }

        tick()

        // 变更驱动：歌词行 / 播放态变化时补一帧 —— 停掉定时器的场景全靠这两条通路
        const unsubLyrics = useLyricsStore.subscribe(tick)
        const unsubPlayer = usePlayerStore.subscribe(tick)

        return () => {
            if (timer !== null) window.clearInterval(timer)
            unsubLyrics()
            unsubPlayer()
            // 卸载时收回菜单栏位图，别让托盘停在一句没有上下文的歌词上
            void invoke('tray:lyricImage', null)
        }
    }, [enabled])
}
