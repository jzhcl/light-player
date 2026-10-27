import { LP_EVENT, type LpEvent } from '@shared/event'

type Handler = (...args: unknown[]) => void

/**
 * 渲染进程内部事件总线
 */
export function createEventBus() {
    const eventMap = new Map<string, Handler[]>()

    const on = (event: string, handler: Handler): (() => void) => {
        const handlers = eventMap.get(event) ?? []
        handlers.push(handler)
        eventMap.set(event, handlers)

        // 返回取消监听函数
        return () => off(event, handler)
    }

    const once = (event: string, handler: Handler): (() => void) => {
        const wrapper: Handler = (...args) => {
            off(event, wrapper)
            handler(...args)
        }
        return on(event, wrapper)
    }

    const off = (event: string, handler: Handler): void => {
        const handlers = eventMap.get(event)
        if (!handlers) return

        const index = handlers.indexOf(handler)
        if (index === -1) return

        handlers.splice(index, 1)
        if (handlers.length === 0) eventMap.delete(event)
    }

    const emit = (event: string, ...args: unknown[]): void => {
        const handlers = eventMap.get(event)
        if (!handlers) return

        // 防止 handler 内部增删监听导致迭代异常
        ;[...handlers].forEach(h => h(...args))
    }

    return {
        on,
        once,
        off,
        emit,
    }
}

export const eventBus = createEventBus()
export { LP_EVENT }
export type { LpEvent }
