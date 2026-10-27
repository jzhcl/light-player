import { useEffect, useLayoutEffect, useRef } from 'react'
import { getKaraokeTimeMs } from './karaokeClock'
import { followAnchor, followOffset, stepOffset } from './follow'

interface KaraokeLineProps {
    /** 当前行的逐字分词（词间空格已由 buildDisplayLines 补好） */
    words: LyricWordSeg[]
    /** 是否正在播放。暂停时本地时钟已冻结，只需定格一帧 */
    isPlaying: boolean
    /**
     * 溢出跟随：整行比视口宽时做水平位移，让正在唱的那个词停在视口中心。
     *
     * 只有桌面歌词窗开 —— 播放页是不定宽滚动列表（溢出换行）、控制栏预览是省略号，
     * 三处各有各的口径。关掉时不渲染滑动层，DOM 与从前完全一致。
     */
    follow?: boolean
}

/** 滑动层的几何量。每行只量一次，播放期间只读不算。 */
interface TrackGeometry {
    /** 各词中心，相对滑动层左边缘 */
    centers: number[]
    /** 整行宽 */
    lineWidth: number
    /** 视口宽（行盒 clientWidth） */
    view: number
}

/**
 * 本帧该把滑动层放在哪。
 *
 * 锚点由 `followAnchor` 连续给出（逐字推进），平滑器只负责抹掉词与词的速度阶跃 ——
 * 别把锚点退回「当前词中心」那种逐词跳变，那正是手感变差的根源。
 */
function targetOffset(geometry: TrackGeometry, words: LyricWordSeg[], tMs: number): number {
    const anchor = followAnchor(words, geometry.centers, tMs)
    return followOffset(geometry.view, geometry.lineWidth, anchor)
}

/**
 * 逐字行：只有当前行会渲染这一层。
 *
 * 露出效果用两层重叠文本实现：底层常态、上层高亮色，靠裁剪上层的右边界推进。
 *
 * 时间基准 karaokeClock 由调用方负责校准 —— 主窗在 `engine` 订阅播放器，
 * 歌词窗在 `useLyricChannel` 订阅主窗推送；本组件只读时钟 + 写样式，
 * 不持有定时器、不订阅任何 store、不产生 React 更新。
 *
 * 开了 `follow` 则多一层滑动层，位移也在同一条 rAF 里算 —— 与裁剪共用一次遍历、
 * 共用同一份词几何，同样不产生 React 更新。
 */
export function KaraokeLine({ words, isPlaying, follow = false }: KaraokeLineProps) {
    const highlightRefs = useRef<(HTMLSpanElement | null)[]>([])
    /** 上一次写进 DOM 的进度：值没变就不碰 DOM，一帧里真正在变的通常只有当前那个词 */
    const painted = useRef<number[]>([])

    /** 滑动层（仅 follow）。它的父节点就是视口 —— `.lyric-line`。 */
    const trackRef = useRef<HTMLDivElement | null>(null)
    const geometry = useRef<TrackGeometry | null>(null)
    /** 当前写到 DOM 上的位移。 */
    const offset = useRef(0)
    /**
     * 上一次写位移的时刻。归零 = 「下一帧直接落位、不做平滑」 ——
     * 换行 / 缩放 / 暂停定格三条路径都靠它。老项目就是在换行时让位移从上一行的
     * 位置过渡过来，才把新一行「甩」进视口的。
     */
    const lastPaintAt = useRef(0)

    /** 量几何：只在换行与尺寸变化时调用。 */
    const measure = (): void => {
        const track = trackRef.current
        const view = track?.parentElement
        if (!track || !view) {
            geometry.current = null
            return
        }
        const centers: number[] = []
        for (const child of track.children) {
            const el = child as HTMLElement
            centers.push(el.offsetLeft + el.offsetWidth / 2)
        }
        geometry.current = { centers, lineWidth: track.offsetWidth, view: view.clientWidth }
    }

    // 换行：DOM 已提交，此刻量到的就是最终几何。顺手把位移直接落到目标上 ——
    // 不能只标记「下一帧落位」，否则新内容会带着上一行的位移先画一帧。
    useLayoutEffect(() => {
        if (!follow) {
            geometry.current = null
            return
        }
        measure()
        lastPaintAt.current = 0

        const track = trackRef.current
        const g = geometry.current
        offset.current = track && g ? targetOffset(g, words, getKaraokeTimeMs()) : 0
        if (track) track.style.transform = `translateX(${offset.current.toFixed(2)}px)`
    }, [words, follow])

    useEffect(() => {
        // 换行 / 换歌 / 播放态变化都重算一遍，先清掉「已写入」缓存。
        // 时间戳一并归零：本 effect 的第一帧必须是定格（换行要吸附、暂停要定格在那一刻），
        // 不归零的话它会按「距上一次写位移过了多久」走成半途的平滑 —— 暂停那条只画一帧的
        // 路径会因此停在半路上不动了。平滑只发生在同一次播放会话的后续帧里。
        painted.current = []
        lastPaintAt.current = 0

        /** 把当前时刻的进度刷进 DOM。只读时钟 + 写样式，不产生任何 React 更新。 */
        const paint = (): void => {
            const t = getKaraokeTimeMs()
            for (let i = 0; i < words.length; i++) {
                const el = highlightRefs.current[i]
                if (!el) continue

                const w = words[i]
                const duration = w.end - w.start
                const p = t <= w.start ? 0 : t >= w.end ? 1 : duration > 0 ? (t - w.start) / duration : 1
                if (painted.current[i] === p) continue
                painted.current[i] = p

                el.style.clipPath = `inset(0 ${((1 - p) * 100).toFixed(2)}% 0 0)`
            }

            if (!follow) return
            const track = trackRef.current
            const g = geometry.current
            if (!track || !g) return

            const now = performance.now()
            // 首帧 / 时间戳刚被归零 → dt = 0 → 直接落位
            const dt = lastPaintAt.current ? now - lastPaintAt.current : 0
            lastPaintAt.current = now

            offset.current = stepOffset(offset.current, targetOffset(g, words, t), dt)
            track.style.transform = `translateX(${offset.current.toFixed(2)}px)`
        }

        // 视口 / 整行尺寸变化（窗口缩放、改字号）→ 重量几何并落位。
        // 不重量的话锚点会整体错位（词中心是相对滑动层量的，滑动层宽度会跟着字号变）。
        let observer: ResizeObserver | undefined
        if (follow) {
            const track = trackRef.current
            const view = track?.parentElement
            if (track && view) {
                observer = new ResizeObserver(() => {
                    measure()
                    lastPaintAt.current = 0
                    if (!isPlaying) paint()
                })
                // 两层都盯：视口变 → 可用的居中范围变；滑动层变 → 词位置变（字号 / 字体）
                observer.observe(track)
                observer.observe(view)
            }
        }

        // 暂停时不要启循环：时钟此刻已冻结在最后一次真实时间上，只画一帧定格画面即可。
        // 少了这道门控，暂停后 rAF 会一直空转。
        if (!isPlaying) {
            paint()
            return () => observer?.disconnect()
        }

        let raf = requestAnimationFrame(function loop() {
            paint()
            raf = requestAnimationFrame(loop)
        })
        return () => {
            cancelAnimationFrame(raf)
            observer?.disconnect()
        }
    }, [words, isPlaying, follow])

    const content = words.map((w, i) => (
        <span key={i} className="karaoke-word">
            <span className="karaoke-word-base">{w.text}</span>
            <span
                className="karaoke-word-highlight"
                ref={(el) => {
                    highlightRefs.current[i] = el
                }}
                aria-hidden="true"
            >
                {w.text}
            </span>
        </span>
    ))

    // 不开跟随时保持原样：词直接铺在行盒里，不引入任何多余节点。
    if (!follow) return <>{content}</>

    return (
        <div className="karaoke-track" ref={trackRef}>
            {content}
        </div>
    )
}
