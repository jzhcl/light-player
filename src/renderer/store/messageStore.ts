import { create } from 'zustand'


export type MessageType = 'info' | 'success' | 'warn' | 'error'

export interface MessageItem {
    id: number
    type: MessageType
    text: string
    /** 自动关闭时长（ms），0 表示不自动关闭 */
    duration: number
    /** 是否显示关闭按钮。缺省规则：仅常驻消息（duration 为 0）显示，否则它没有别的关闭途径 */
    closable: boolean
    /** 入场时间戳：悬停暂停后恢复计时的基准 */
    createdAt: number
    /** 退出动画进行中：已触发关闭、尚未从列表移除 */
    leaving: boolean
}

/** 同屏最多保留条数，超出时最旧的一条走退出动画让位 */
const MAX_MESSAGES = 3
/** 退出动画时长，须与 layout/components.css 中 .message-item 的 transition 保持一致 */
const EXIT_DURATION = 500
/** 各类型默认停留时长（ms）：错误停留最久，便于用户读完 */
const DEFAULT_DURATION: Record<MessageType, number> = {
    info: 3000,
    success: 3000,
    warn: 4000,
    error: 5000,
}

interface MessageStoreState {
    messages: MessageItem[]
    /**
     * @param duration 自动关闭时长（ms），0 表示不自动关闭；缺省按类型取默认值
     * @param closable 是否显示关闭按钮；缺省仅当 duration 为 0 时显示
     */
    push: (type: MessageType, text: string, duration?: number, closable?: boolean) => number
    dismiss: (id: number) => void
}

let nextId = 1

/**
 * 消息通知状态。
 * 只存数据：自动关闭的定时器由 MessageHost 内的 effect 持有（生命周期跟随组件），
 * 唯一例外是 dismiss 的「退出动画延时移除」，因为它必须在组件卸载后照样完成。
 */
export const useMessageStore = create<MessageStoreState>((set, get) => ({
    messages: [],
    push: (type, text, duration, closable) => {
        const id = nextId++
        const resolved = duration ?? DEFAULT_DURATION[type]
        const next = [...get().messages, {
            id,
            type,
            text,
            duration: resolved,
            closable: closable ?? (resolved === 0),
            createdAt: Date.now(),
            leaving: false,
        }]
        set({ messages: next })
        // 容量上限
        const active = next.filter((m) => !m.leaving)
        if (active.length > MAX_MESSAGES) get().dismiss(active[0].id)
        return id
    },
    dismiss: (id) => {
        const target = get().messages.find((m) => m.id === id)
        if (!target || target.leaving) return
        set((s) => ({
            messages: s.messages.map((m) => (m.id === id ? { ...m, leaving: true } : m)),
        }))
        window.setTimeout(() => {
            set((s) => ({ messages: s.messages.filter((m) => m.id !== id) }))
        }, EXIT_DURATION)
    },
}))
