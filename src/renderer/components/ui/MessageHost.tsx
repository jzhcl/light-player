import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { IconName } from '@assets/icons'
import { Icon } from '@renderer/components/Icon'
import { useMessageStore, type MessageItem, type MessageType } from '@renderer/store/messageStore'


const TYPE_ICON: Record<MessageType, IconName> = {
    info: 'info-circle',
    success: 'check-circle',
    warn: 'exclamation-circle',
    error: 'x-circle',
}

/** 收起态：每层向上位移（px）与缩放递减 */
const COLLAPSED_OFFSET = 12
const SCALE_STEP = 0.05
const MIN_SCALE = 0.8
/** 悬停展开态：层间距（px），展开后各层还原为原尺寸 */
const EXPANDED_OFFSET = 60
/** 退出动画的目标缩放 */
const LEAVING_SCALE = 0.7
/** 鼠标移出后延迟收起，给指针在卡片间隙移动留出容错 */
const COLLAPSE_DELAY = 500

/**
 * 堆叠次序：visualIndex = 0 为最新一条（最靠近底边、收起时完整可见），依次向上叠。
 * 与 store 数组顺序相反（新消息 push 到末尾）。
 */
function getItemStyle(
    visualIndex: number,
    total: number,
    hovered: boolean,
    leaving: boolean,
): CSSProperties {
    // 底部放置
    const offset = -visualIndex * (hovered ? EXPANDED_OFFSET : COLLAPSED_OFFSET)
    let scale: number
    if (leaving) scale = LEAVING_SCALE
    else if (hovered) scale = 1
    else scale = Math.max(1 - visualIndex * SCALE_STEP, MIN_SCALE)

    return {
        transform: `translateY(${offset}px) scale(${scale})`,
        // 最新的压在最上层
        zIndex: total - visualIndex,
        // 收起态只有最上层可交互；展开后全部可点；正在退出的不可点
        pointerEvents: leaving ? 'none' : (visualIndex === 0 || hovered ? 'auto' : 'none'),
    }
}

interface MessageToastProps {
    item: MessageItem
    /** 悬停暂停：计时冻结，移出后按剩余时长继续 */
    paused: boolean
    style: CSSProperties
}

function MessageToast({ item, paused, style }: MessageToastProps) {
    const dismiss = useMessageStore((s) => s.dismiss)
    // 剩余时长：暂停时结算，恢复后按剩余继续倒计时（而非重新计时全长）
    const remainingRef = useRef(item.duration)
    const startedAtRef = useRef<number | null>(null)

    useEffect(() => {
        if (item.duration <= 0) return

        if (paused) {
            if (startedAtRef.current !== null) {
                remainingRef.current -= Date.now() - startedAtRef.current
                startedAtRef.current = null
            }
            // 悬停期间已耗尽剩余时长：恢复时立即关闭
            if (remainingRef.current <= 0) dismiss(item.id)
            return
        }

        startedAtRef.current = Date.now()
        const timer = window.setTimeout(() => dismiss(item.id), remainingRef.current)
        return () => window.clearTimeout(timer)
    }, [item.id, item.duration, paused, dismiss])

    return (
        <div
            className={`message-item message-item--${item.type}${item.leaving ? ' is-leaving' : ''}`}
            style={style}
        >
            <span className="message-item-icon">
                <Icon name={TYPE_ICON[item.type]} size={18}/>
            </span>
            <span className="message-item-text">{item.text}</span>
            {item.closable && (
                <button
                    type="button"
                    className="message-item-close"
                    aria-label="关闭"
                    onClick={() => dismiss(item.id)}
                >
                    <Icon name="x" size={14}/>
                </button>
            )}
        </div>
    )
}

/**
 * 消息宿主
 * 卡片贴底堆叠、自下而上冒出，悬停时向上展开并暂停计时
 */
export function MessageHost() {
    const messages = useMessageStore((s) => s.messages)
    const [hovered, setHovered] = useState(false)
    const collapseTimer = useRef<number | null>(null)

    // 卸载时清理延迟收起定时器
    useEffect(() => () => {
        if (collapseTimer.current) window.clearTimeout(collapseTimer.current)
    }, [])

    // 队列清空时复位悬停状态，避免下一条消息入场即处于展开态
    useEffect(() => {
        if (messages.length > 0) return
        if (collapseTimer.current) {
            window.clearTimeout(collapseTimer.current)
            collapseTimer.current = null
        }
        setHovered(false)
    }, [messages.length])

    const handleEnter = () => {
        if (collapseTimer.current) {
            window.clearTimeout(collapseTimer.current)
            collapseTimer.current = null
        }
        setHovered(true)
    }

    const handleLeave = () => {
        if (collapseTimer.current) window.clearTimeout(collapseTimer.current)
        collapseTimer.current = window.setTimeout(() => setHovered(false), COLLAPSE_DELAY)
    }

    if (messages.length === 0) return null

    return createPortal(
        <div
            className="message-host"
            role="status"
            aria-live="polite"
            onMouseEnter={handleEnter}
            onMouseLeave={handleLeave}
        >
            {messages.map((item, index) => (
                <MessageToast
                    key={item.id}
                    item={item}
                    paused={hovered}
                    style={getItemStyle(
                        messages.length - 1 - index,
                        messages.length,
                        hovered,
                        item.leaving,
                    )}
                />
            ))}
        </div>,
        document.body,
    )
}
