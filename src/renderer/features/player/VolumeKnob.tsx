import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import type { IconName } from '@assets/icons'
import { Icon } from '@renderer/components/Icon'
import { useSettingsStore } from '@renderer/store'
import { player } from './player'

/** 滚轮一格的音量步长 */
const WHEEL_STEP = 0.05

/**
 * 环的可视弧：从左下 225° 起、顺时针扫 270° 到右下 135°，正下方留 90° 缺口。
 *
 * ⚠️ 只在 `.tsx` 里定义，CSS 通过 `--vol-offset` / `--vol-sweep` 消费。
 * 环的填充弧、指示点的旋转都必须用同一组值，否则会「值和锚点对不上」。
 */
const OFFSET = 225
const SWEEP = 270

/** 指针相对旋钮中心的角度：正上方 = 0、顺时针增大，范围 [0, 360)。 */
function angleAt(el: HTMLElement, clientX: number, clientY: number): number {
    const r = el.getBoundingClientRect()
    const dx = clientX - (r.left + r.width / 2)
    const dy = clientY - (r.top + r.height / 2)
    // atan2 在屏幕坐标里 0 在 3 点方向、顺时针为正（y 向下）；+90° 转成「0 在正上方」
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI + 90
    return ((deg % 360) + 360) % 360
}

/**
 * 把角度差归一化到 (-180, 180] —— 取最短方向。
 * ⚠️ 这一条是「不会从 100 跳到 0」的关键：直接相减时，指针从 350° 跨到 10° 会得到 -340°，
 * 换算成音量就是瞬间掉 126%。取最短差之后它只有 +20°。
 */
function shortestDelta(from: number, to: number): number {
    let d = to - from
    if (d > 180) d -= 360
    if (d < -180) d += 360
    return d
}

/**
 * 点击时的绝对映射：落在可视弧内 → 0~1；落在缺口里 → `null`（不改值）。
 * 只有「按下」这一刻用它 —— 满足「点哪到哪」。
 */
function volumeAt(angle: number): number | null {
    const rel = (((angle - OFFSET) % 360) + 360) % 360
    if (rel > SWEEP) return null
    return rel / SWEEP
}

/**
 * 音量旋钮：按钮外面一圈**带缺口的圆环**表示音量，环上有一个指示点落在当前角度上。
 *
 * - 点击：按指针所在角度直接设值（点哪到哪）；
 * - 拖拽：走相对累加 —— 每次只取「指针相对上一帧转过的最短角度」，累到当前值上再 clamp。
 *   ⚠️ 这是唯一能消掉「100 → 0」的做法。绝对角度映射在圆上是间断函数，
 *   任何切口（缺口）只是把跳变往后推 —— 跨过缺口那一下照样从 100 跳到 0。
 *   相对累加则天然连续：转满了就停在 100，反向转才回落。
 * - 滚轮：±`WHEEL_STEP`；
 * - 环与指示点常隐，悬停/拖拽时淡入（热区不变，隐藏态也能点）。
 *
 * ⚠️ 指针事件只挂在外层容器上（环 / 指示点 / 图标都 `pointer-events: none`），
 * 否则鼠标落在环上时事件目标变成子元素、`getBoundingClientRect` 的中心就错了。
 * ⚠️ 先写值、再尝试 `setPointerCapture`：捕获在某些环境下会抛，放在前面一旦抛出
 * 就会把「点击设值」整段跳过 —— 症状正是「点了没反应」。
 */
export function VolumeKnob() {
    const volume = useSettingsStore((s) => s.settings['player.audio.volume'])
    const [dragging, setDragging] = useState(false)
    /** 拖拽状态：上一帧的指针角度。`null` = 没在拖 */
    const dragRef = useRef<number | null>(null)
    /**
     * 当前值的本地镜。拖拽里连续累加必须读它 ——
     * 读 store 会拿到上一次渲染的快照，同一帧内多次 pointermove 会互相覆盖。
     */
    const volRef = useRef(volume)

    useEffect(() => {
        volRef.current = volume
    }, [volume])

    const apply = useCallback((v: number) => {
        const next = Math.min(1, Math.max(0, v))
        volRef.current = next
        player.setVolume(next)
    }, [])

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        e.preventDefault()
        const angle = angleAt(e.currentTarget, e.clientX, e.clientY)
        // 值先落下去（绝对位置）
        const abs = volumeAt(angle)
        if (abs !== null) apply(abs)
        dragRef.current = angle
        setDragging(true)
        try {
            e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
            /* 捕获失败不影响拖拽：pointermove 仍会冒泡到这个元素 */
        }
    }

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const prev = dragRef.current
        if (prev === null) return
        const angle = angleAt(e.currentTarget, e.clientX, e.clientY)
        const delta = shortestDelta(prev, angle)
        dragRef.current = angle
        if (delta === 0) return
        // 转过整整 SWEEP 度 = 音量变化 1.0；累加而不是映射 ⇒ 连续、可 clamp、不跳
        apply(volRef.current + delta / SWEEP)
    }

    const stopDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        dragRef.current = null
        setDragging(false)
        try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId)
            }
        } catch {
            /* 没捕获过就什么都不用做 */
        }
    }

    const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
        apply(volRef.current + (e.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP))
    }

    const icon: IconName =
        volume <= 0 ? 'volume-mute-fill' : volume < 0.5 ? 'volume-down-fill' : 'volume-up-fill'

    return (
        <div
            className={`play-vol${dragging ? ' is-dragging' : ''}`}
            role="slider"
            aria-label="音量"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(volume * 100)}
            title={`音量 ${Math.round(volume * 100)}%`}
            style={
                {
                    '--vol': volume,
                    '--vol-offset': `${OFFSET}deg`,
                    '--vol-sweep': `${SWEEP}deg`,
                } as CSSProperties
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={stopDrag}
            onPointerCancel={stopDrag}
            onWheel={onWheel}
        >
            <span className="play-vol-visual">
                <span className="play-vol-ring"/>
                <span className="play-vol-handle"/>
            </span>

            <span className="play-vol-icon">
                <Icon name={icon} size={16}/>
            </span>
        </div>
    )
}
