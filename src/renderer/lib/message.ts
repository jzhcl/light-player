import { LP_EVENT } from '@shared/event'
import { useMessageStore, type MessageType } from '@renderer/store/messageStore'


/**
 * 消息文本归一化
 */
const toText = (msg: unknown): string => {
    if (typeof msg === 'string') return msg
    if (msg instanceof Error) return msg.message || msg.name
    if (msg && typeof msg === 'object' && typeof (msg as { message?: unknown }).message === 'string') {
        return (msg as { message: string }).message
    }
    return JSON.stringify(msg)
}

let handlerRegistered = false

/**
 * 桥接主进程经 LP_EVENT 推送的消息到消息队列
 *
 * @returns 取消订阅函数。
 */
export function initMessageHandler(): () => void {
    if (handlerRegistered) return () => {}
    handlerRegistered = true

    const channels: Array<[string, MessageType]> = [
        [LP_EVENT['MESSAGE.INFO'], 'info'],
        [LP_EVENT['MESSAGE.SUCCESS'], 'success'],
        [LP_EVENT['MESSAGE.WARNING'], 'warn'],
        [LP_EVENT['MESSAGE.ERROR'], 'error'],
    ]
    const unsubscribers = channels.map(([channel, type]) =>
        window.api.on(channel, (m) => useMessageStore.getState().push(type, toText(m))),
    )

    return () => {
        unsubscribers.forEach((unsub) => unsub())
        handlerRegistered = false
    }
}

/**
 * duration 自动关闭时长（ms），0 表示不自动关闭；缺省按类型取默认值
 * closable 是否显示关闭按钮；缺省仅当常驻消息显示
 */
const emit = (type: MessageType) =>
    (m: unknown, duration?: number, closable?: boolean): void => {
        useMessageStore.getState().push(type, toText(m), duration, closable)
    }

/**
 * 渲染侧直接调用的快捷方法
 */
export const message = {
    info: emit('info'),
    success: emit('success'),
    warn: emit('warn'),
    error: emit('error'),
}
