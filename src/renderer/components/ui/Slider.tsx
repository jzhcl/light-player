import { useState } from 'react'
import * as SliderPrimitive from '@radix-ui/react-slider'

// 滑块：Radix Slider 提供键盘/拖拽/点击轨道跳值/无障碍，本组件只做类名与能力开关。
export interface SliderProps {
    value: number
    min?: number
    max?: number
    step?: number
    /** 禁用 */
    disabled?: boolean
    /**
     * 圆点默认隐形，悬停 / 拖拽 / 键盘聚焦时才显形。
     * 轨道与已填充始终可见。
     */
    autoHideThumb?: boolean
    /** 值变化即触发（拖拽过程中会持续触发），适合纯展示/本地草稿态 */
    onChange: (v: number) => void
    /** 操作结束才触发一次（拖拽松手/键盘调整/点击轨道），适合提交型写入 */
    onCommit?: (v: number) => void
    className?: string
    /** 读屏名称 */
    ariaLabel?: string
}

export function Slider({
    value,
    min = 0,
    max = 100,
    step = 1,
    disabled = false,
    autoHideThumb = false,
    onChange,
    onCommit,
    className,
    ariaLabel,
}: SliderProps) {
    // 拖拽态：Radix 用 pointer capture 把后续指针事件留在元素上，指针一旦移出元素
    // :hover 就失效 —— 光靠 CSS 会让圆点在拖拽途中淡掉，所以这里自己记一笔。
    const [dragging, setDragging] = useState(false)

    return (
        <SliderPrimitive.Root
            className={`slider${autoHideThumb ? ' slider--auto-hide' : ''}${dragging ? ' is-dragging' : ''} ${className ?? ''}`}
            value={[value]}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            onPointerDown={() => {
                if (!disabled) setDragging(true)
            }}
            onPointerUp={() => setDragging(false)}
            onPointerCancel={() => setDragging(false)}
            onValueChange={([v]) => onChange(v)}
            onValueCommit={onCommit ? ([v]) => onCommit(v) : undefined}
        >
            <SliderPrimitive.Track className="slider-track">
                <SliderPrimitive.Range className="slider-range"/>
            </SliderPrimitive.Track>
            <SliderPrimitive.Thumb className="slider-thumb" aria-label={ariaLabel ?? 'value'}/>
        </SliderPrimitive.Root>
    )
}
