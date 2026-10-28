import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import type { QueueEntry } from '@renderer/features/song/songKey'
import { planDropSong } from '@renderer/features/player/queueModel'
import { songDeleted } from '@renderer/lib/batchedEvents'

/**
 * 播放队列的 store
 */

/** 队列落盘的防抖延迟 */
const PERSIST_DELAY = 300
/**
 * 队列自己的键：**整切片存一个键**。`queue` 与 `currentIndex` 是耦合的
 * （索引离开队列就没有意义），拆成两个键就会出现「指针指向不存在的项」的中间态。
 */
const QUEUE_KEY = 'rq:queue'
export interface QueueSlice {
    queue: QueueEntry[]
    currentIndex: number
}

export function getDefaultQueueSlice(): QueueSlice {
    return { queue: [], currentIndex: -1 }
}

/**
 * 队列的 localStorage 持久化。
 */
function makeQueueStorage(delay: number): PersistStorage<QueueSlice> {
    /** 已成功落盘（或 hydrate 时读到）的序列化结果 */
    let written: string | null = null
    /** 上次过手时的值引用 —— 两字段都没换引用才整键跳过 */
    let seen: QueueSlice | null = null
    /** 是否已报告过写入失败，避免反复刷日志 */
    let reported = false
    let timer: number | null = null
    let pending: string | null = null

    const flush = () => {
        if (timer !== null) {
            window.clearTimeout(timer)
            timer = null
        }
        if (pending === null) return
        const s = pending
        pending = null
        try {
            localStorage.setItem(QUEUE_KEY, s)
            written = s
            reported = false
        } catch (e) {
            // 清掉引用记忆 → 该值下次仍会被判为「有变化」，从而重试而不是静默丢掉
            seen = null
            if (!reported) {
                reported = true
            }
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', flush)
        window.addEventListener('beforeunload', flush)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush()
        })
    }

    const write = (slice: QueueSlice) => {
        if (seen && seen.queue === slice.queue && seen.currentIndex === slice.currentIndex) return
        seen = slice
        const s = JSON.stringify(slice)
        if (written === s) return
        pending = s
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(flush, delay)
    }

    return {
        getItem: () => {
            // ① 队列自己的键（存在就以它为准，绝不覆盖）
            const raw = localStorage.getItem(QUEUE_KEY)
            if (raw !== null) {
                try {
                    const parsed = JSON.parse(raw) as Partial<QueueSlice>
                    const slice: QueueSlice = {
                        queue: Array.isArray(parsed.queue) ? parsed.queue : [],
                        currentIndex: typeof parsed.currentIndex === 'number' ? parsed.currentIndex : -1,
                    }
                    written = raw
                    seen = slice
                    return { state: slice, version: 1 }
                } catch (e) {
                    // 值被写坏 → 回落默认值；下面的写入会覆盖掉坏值（自愈）
                }
            }
            // ② 首次运行 / 盘上值损坏 → 回落默认值，并写盘
            // （只放内存则用户不动队列就永远不落盘）
            const slice = getDefaultQueueSlice()
            const serialized = JSON.stringify(slice)
            try {
                localStorage.setItem(QUEUE_KEY, serialized)
            } catch (e) {
            }
            written = serialized
            seen = slice
            return { state: slice, version: 1 }
        },
        setItem: (_name, value) => write(value.state),
        removeItem: () => {
            if (timer !== null) {
                window.clearTimeout(timer)
                timer = null
            }
            pending = null
            localStorage.removeItem(QUEUE_KEY)
            // 引用记忆同样要清：否则清空后写回「与清空前一模一样的值」会被判成没变而不落盘
            written = null
            seen = null
            reported = false
        },
    }
}

interface QueueStoreState extends QueueSlice {
    /** **原子**写入队列与指针 —— 两者耦合，分开写会露出「指针指向不存在的项」的中间态 */
    setQueue: (queue: QueueEntry[], currentIndex: number) => void
}

export const useQueueStore = create<QueueStoreState>()(
    persist(
        (set) => ({
            ...getDefaultQueueSlice(),
            setQueue: (queue, currentIndex) => set({ queue, currentIndex }),
        }),
        {
            name: 'rq-queue',
            version: 1,
            storage: makeQueueStorage(PERSIST_DELAY),
            partialize: (state) => ({ queue: state.queue, currentIndex: state.currentIndex }),
            merge: (persisted, current) => {
                const p = persisted as Partial<QueueSlice> | undefined
                if (!p) return current
                return {
                    ...current,
                    queue: Array.isArray(p.queue) ? p.queue : [],
                    currentIndex: typeof p.currentIndex === 'number' ? p.currentIndex : -1,
                }
            },
        },
    ),
)

/** 歌曲被删除时摘掉队列里指向它的全部条目，并重算 currentIndex */
songDeleted.subscribe((ids) => {
    let { queue, currentIndex } = useQueueStore.getState()
    let changed = false
    for (const id of ids) {
        const plan = planDropSong(queue, currentIndex, id)
        if (!plan) continue
        queue = plan.queue
        currentIndex = plan.currentIndex
        changed = true
    }
    if (changed) useQueueStore.getState().setQueue(queue, currentIndex)
})
