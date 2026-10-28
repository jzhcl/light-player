import { eventBus } from './eventBus'
import { LP_EVENT } from '@shared/event'

/**
 * 高频事件聚合：把同一轮里的多次 emit 合并成一次回调。
 */
export interface BatchedEvent<T> {
    /** 订阅合并后的批次；返回取消订阅 */
    subscribe(handler: (batch: T[]) => void): () => void
    /** 立即结算当前批次（测试 / 退出前用） */
    flush(): void
}

export function createBatchedEvent<T>(channel: string, delayMs = 0): BatchedEvent<T> {
    const handlers = new Set<(batch: T[]) => void>()
    let pending: T[] = []
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = (): void => {
        if (timer !== null) {
            clearTimeout(timer)
            timer = null
        }
        if (pending.length === 0) return
        const batch = pending
        pending = []
        for (const handler of handlers) handler(batch)
    }

    eventBus.on(channel, (payload) => {
        pending.push(payload as T)
        if (timer !== null) return
        timer = setTimeout(() => {
            timer = null
            flush()
        }, delayMs)
    })

    return {
        subscribe(handler) {
            handlers.add(handler)
            return () => {
                handlers.delete(handler)
            }
        },
        flush,
    }
}

/** 歌曲删除 */
export const songDeleted = createBatchedEvent<string>(LP_EVENT['SONG.DELETED'], 50)
