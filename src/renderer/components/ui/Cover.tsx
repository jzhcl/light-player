import { memo, useEffect, useRef, useState, type Ref } from 'react'
import { toFileUrl } from '@renderer/lib/utils'

/**
 * 封面的两种形态：`LP.Song.pic` 是对象（在线地址 + 落盘路径），`LP.Plugin.Song.pic` 是裸 URL
 */
export type PicLike = string | { url?: string; path?: string }

/**
 * 封面候选地址
 */
function toPicCandidates(pic?: PicLike): string[] {
    if (!pic) return []
    if (typeof pic === 'string') return [pic]
    const list: string[] = []
    if (pic.path) list.push(toFileUrl(pic.path))
    if (pic.url) list.push(pic.url)
    return list
}

// 所有懒加载封面共用一个 IntersectionObserver
const waiting = new WeakMap<Element, () => void>()
let probe: IntersectionObserver | null = null

/** 元素进入（或接近）视口时回调一次；返回取消函数 */
function onApproach(el: Element, notify: () => void): () => void {
    probe ??= new IntersectionObserver(
        (entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                const fire = waiting.get(entry.target)
                if (fire === undefined) continue
                waiting.delete(entry.target)
                probe?.unobserve(entry.target) // 命中即停止观察：显示过的封面不会回退
                fire()
            }
        },
        // 提前 300px 加载：滚到跟前时图片多半已就位，看不到占位图被换掉的闪动
        { rootMargin: '300px 0px' },
    )
    waiting.set(el, notify)
    probe.observe(el)
    return () => {
        waiting.delete(el)
        probe?.unobserve(el)
    }
}

/**
 * 封面图
 */
interface CoverProps {
    pic?: PicLike
    /** 图片与占位共用的类名 */
    className?: string
    /**
     * 懒加载。
     * 控制栏 / 导航栏 / 页头这类一眼可见的位置别开 —— 只会多一次「占位 → 图片」的切换。
     */
    lazy?: boolean
}

function CoverImpl({ pic, className, lazy = false }: CoverProps) {
    const candidates = toPicCandidates(pic)
    // 回退进度按「候选串」记账：同一位置换了图（候选串变了）自动从头开始，无需副作用重置
    const sig = candidates.join('|')
    const [probeState, setProbeState] = useState({ sig, attempt: 0 })
    const attempt = probeState.sig === sig ? probeState.attempt : 0
    const src = candidates[attempt]

    const hostRef = useRef<HTMLSpanElement | null>(null)
    const [near, setNear] = useState(false)

    // 懒加载登记：等占位图进入视口再换成 <img>（near 为 true 后不再观察）
    useEffect(() => {
        if (!lazy || near || !src) return
        const el = hostRef.current
        if (el === null) return
        return onApproach(el, () => setNear(true))
    }, [lazy, near, src])

    if (!src || (lazy && !near)) return <CoverPlaceholder className={className} hostRef={hostRef}/>

    return (
        <img
            className={className}
            src={src}
            alt=""
            draggable={false}
            onError={() => setProbeState({ sig, attempt: attempt + 1 })}
        />
    )
}

/** 内置唱片占位图 */
function CoverPlaceholder({ className, hostRef }: {
    className?: string
    /** 懒加载时由 Cover 传入：用占位元素本身充当视口探针 */
    hostRef?: Ref<HTMLSpanElement>
}) {
    return (
        <span ref={hostRef} className={`cover-placeholder${className ? ` ${className}` : ''}`}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="12" cy="12" r="10"/>
                <circle cx="12" cy="12" r="3"/>
            </svg>
        </span>
    )
}

export const Cover = memo(CoverImpl)
