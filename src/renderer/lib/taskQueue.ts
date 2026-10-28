import { isOk } from '@shared/result'

/**
 * 有界后台任务队列：按 key 去重 + 优先级 + 合并窗口 + 并发上限 + 有界重试。
 *
 * 适合「先攒一会儿再一起跑」的场景：批量创建时不想每来一条就踢一次 IO。
 */

interface TaskQueueOptions {
    /** 同时执行的任务上限 */
    concurrency?: number
    /** 入队后静默这么久再开跑：把连续入队合并成一批 */
    flushDelayMs?: number
    /** 同一个 key 的尝试上限，超过后进放弃集合（`resetFailures` 之前不再接收） */
    maxAttempts?: number
    /** 第 n 次失败后等多久再试（次数不够时取最后一项） */
    retryDelaysMs?: number[]
    /** 放弃某个 key 时回调（重试耗尽），便于调用方记一条自己的日志 */
    onGiveUp?: (key: string, error: string) => void
}

interface TaskQueue {
    /**
     * 排队。同一个 key 重复入队会被合并：保留后入队的任务，
     * 优先级取较高者。任务正在执行时重复入队会被忽略。
     */
    enqueue(key: string, run: () => Promise<Result<unknown>>, priority?: number): void
    /** 取消排队（已在执行的不中断，由任务自身处理目标消失的情况） */
    cancel(key: string): void
    /** 清空失败计数与放弃集合（例如网络恢复后允许重试） */
    resetFailures(): void
    /** 待办 + 执行中的任务数 */
    size(): number
}

interface Job {
    run: () => Promise<Result<unknown>>
    priority: number
}

export function createTaskQueue(options: TaskQueueOptions = {}): TaskQueue {
    const concurrency = options.concurrency ?? 3
    const flushDelayMs = options.flushDelayMs ?? 300
    const maxAttempts = options.maxAttempts ?? 3
    const retryDelays = options.retryDelaysMs ?? [1000, 5000, 20000]

    /** 待办：key → 任务（Map 保证同优先级按入队顺序取） */
    const pending = new Map<string, Job>()
    /** 执行中：避免同一个 key 被并发跑两遍 */
    const inflight = new Set<string>()
    /** 已失败次数 */
    const attempts = new Map<string, number>()
    /** 重试耗尽，本次生命周期内不再接 */
    const givenUp = new Set<string>()

    let running = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    /** 合并窗口：已有定时器就不再排新的，保证「一批」只触发一次 */
    function schedule(delay: number): void {
        if (timer !== null) return
        timer = setTimeout(() => {
            timer = null
            pump()
        }, delay)
    }

    /** 取优先级最高的一个（相同优先级取先入队的） */
    function takeNext(): { key: string; job: Job } | null {
        let bestKey: string | null = null
        let bestPriority = -Infinity
        for (const [key, job] of pending) {
            if (job.priority > bestPriority) {
                bestKey = key
                bestPriority = job.priority
            }
        }
        if (bestKey === null) return null
        const job = pending.get(bestKey)!
        pending.delete(bestKey)
        return { key: bestKey, job }
    }

    function retryLater(key: string, job: Job, error: string): void {
        const n = (attempts.get(key) ?? 0) + 1
        attempts.set(key, n)
        if (n >= maxAttempts) {
            givenUp.add(key)
            options.onGiveUp?.(key, error)
            return
        }
        const delay = retryDelays[n - 1] ?? retryDelays[retryDelays.length - 1]
        setTimeout(() => {
            if (givenUp.has(key) || pending.has(key) || inflight.has(key)) return
            pending.set(key, job)
            schedule(0)
        }, delay)
    }

    async function execute(key: string, job: Job): Promise<void> {
        let r: Result<unknown>
        try {
            r = await job.run()
        } catch (e) {
            r = { success: false, error: (e as Error).message }
        }
        if (isOk(r)) {
            attempts.delete(key)
            return
        }
        retryLater(key, job, r.error)
    }

    function pump(): void {
        while (running < concurrency) {
            const next = takeNext()
            if (next === null) break
            running++
            inflight.add(next.key)
            void execute(next.key, next.job).finally(() => {
                running--
                inflight.delete(next.key)
                if (pending.size > 0) schedule(0)
            })
        }
    }

    return {
        enqueue(key, run, priority = 0) {
            if (givenUp.has(key) || inflight.has(key)) return
            const prev = pending.get(key)
            pending.set(key, { run, priority: prev ? Math.max(prev.priority, priority) : priority })
            schedule(flushDelayMs)
        },
        cancel(key) {
            pending.delete(key)
            attempts.delete(key)
            givenUp.delete(key)
        },
        resetFailures() {
            givenUp.clear()
            attempts.clear()
        },
        size() {
            return pending.size + running
        },
    }
}
