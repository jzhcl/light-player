import { isQueueRef, queueEntryKey, type QueueEntry } from '@renderer/features/song/songKey'

/**
 * 队列演算的纯函数层
 */

/** 队列变更结果：新队列 + 新当前索引（-1 = 无当前曲） */
export interface QueuePlan {
    queue: QueueEntry[]
    currentIndex: number
}

/** 按唯一键去重（保序，保留首次出现） */
export function dedupeEntries(entries: QueueEntry[]): QueueEntry[] {
    if (entries.length <= 1) return entries.slice()
    const seen = new Set<string>()
    const out: QueueEntry[] = []
    for (const entry of entries) {
        const key = queueEntryKey(entry)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(entry)
    }
    return out
}

/**
 * 插入新项的规划。pos 'begin' 队首 / 'current' 当前曲之后 / 'end' 队尾
 * @returns null = 本次无变更（新项为空，或新项里只有「正在播放的那首」），静默放弃
 *
 * 正在播放的那一项原地不动：既不作为「已存在的同 key 项」被剔除，也不会被重新插一份。
 * 否则同一首歌会被搬到别处、而 currentIndex 还指着它原来的槽位 —— 队列的「当前项」与
 * playerStore.currentSong 就此错位，连 `playNext` 都会跳过或重播。
 */
export function planAdd(
    queue: QueueEntry[],
    currentIndex: number,
    incoming: QueueEntry[],
    pos: 'begin' | 'current' | 'end',
): QueuePlan | null {
    const currentKey =
        currentIndex >= 0 && currentIndex < queue.length ? queueEntryKey(queue[currentIndex]) : null

    const items = dedupeEntries(incoming).filter((entry) => queueEntryKey(entry) !== currentKey)
    if (!items.length) return null

    // 队列里已有的同 key 项先剔除（同曲重入不产生重复行）
    const incomingKeys = new Set(items.map((entry) => queueEntryKey(entry)))
    let removedBefore = 0
    const filtered = queue.filter((item, i) => {
        if (!incomingKeys.has(queueEntryKey(item))) return true
        if (i < currentIndex) removedBefore++
        return false
    })

    let index = currentIndex - removedBefore
    if (index < -1) index = -1

    if (pos === 'begin') {
        return { queue: [...items, ...filtered], currentIndex: index >= 0 ? index + items.length : index }
    }
    if (pos === 'end') {
        return { queue: [...filtered, ...items], currentIndex: index }
    }
    // 'current'：插到当前曲之后；索引无效（-1）时等价于插到队首
    return {
        queue: [...filtered.slice(0, index + 1), ...items, ...filtered.slice(index + 1)],
        currentIndex: index,
    }
}

/** 「插到当前曲之后并立刻起播」的规划结果 */
export interface PlayAfterPlan {
    /** 新队列与新当前索引；`replay` 时为原样返回 */
    plan: QueuePlan
    /** 立刻起播的下标（选区第一项） */
    startIndex: number
    /** 选区只有「正在播放的那首」：原地从头上重播，队列不变 */
    replay: boolean
}

/**
 * 把选区按给定顺序插到当前曲之后，并从选区第一项起播。
 *
 * 与 `planAdd(..., 'current')` 的差别全在「选区里含正在播放的那首」时怎么排：
 *  - 选区 = [B]（B 正在播）→ 原地重播，队列不动（`planAdd` 会返回 null，点了没反应）；
 *  - 选区 = [A, B, C]（B 正在播）→ 把 B 从原槽位挪进选区中它自己的位置，队列成为
 *    A、B、C（B 仍在播，指针不动），随后从 A 起播。
 *
 * 入队顺序即选区顺序，不参与随机模式的洗牌：这批是用户显式点选的目标。
 *
 * @returns null = 选区为空，静默放弃
 */
export function planPlayAfter(
    queue: QueueEntry[],
    currentIndex: number,
    incoming: QueueEntry[],
): PlayAfterPlan | null {
    const items = dedupeEntries(incoming)
    if (!items.length) return null

    // 没有当前曲（空队列 / 指针越界）：整批插到队首、从第一项起播
    if (currentIndex < 0 || currentIndex >= queue.length) {
        const plan = planAdd(queue, currentIndex, items, 'begin')
        return plan ? { plan, startIndex: 0, replay: false } : null
    }

    const current = queue[currentIndex]
    const currentKey = queueEntryKey(current)
    const pos = items.findIndex((entry) => queueEntryKey(entry) === currentKey)

    if (pos === 0 && items.length === 1) {
        return { plan: { queue, currentIndex }, startIndex: currentIndex, replay: true }
    }

    // 同 key 项先剔除；`slot` 是当前槽位剔除后的落点。
    // 当前项只有「选区里也点了它」时才摘下来挪位，否则原地不动。
    const incomingKeys = new Set(items.map((entry) => queueEntryKey(entry)))
    let removedBefore = 0
    const filtered = queue.filter((item, i) => {
        if (i === currentIndex) return pos < 0
        if (!incomingKeys.has(queueEntryKey(item))) return true
        if (i < currentIndex) removedBefore++
        return false
    })
    const slot = currentIndex - removedBefore
    // 选区里的当前项换成队列里的那个实例，其余按选区顺序排列
    const block = items.map((entry) => (queueEntryKey(entry) === currentKey ? current : entry))
    // 选区含当前曲 → 用选区块占住当前槽位；不含 → 插在当前曲之后
    const insertAt = pos < 0 ? slot + 1 : slot

    return {
        plan: {
            queue: [...filtered.slice(0, insertAt), ...block, ...filtered.slice(insertAt)],
            currentIndex: slot,
        },
        startIndex: insertAt,
        replay: false,
    }
}

/**
 * 重排队列的规划。
 *
 * 入参是重排后的全量 key 顺序，必须与当前队列严格一一对应（数量一致、key 全部命中）。
 * 当前曲按 key 重新定位 —— 重排不该改变「正在播放的是哪一首」，只改它落在第几位。
 *
 * @returns null = 与当前队列对不上（拖拽期间队列变过），放弃本次
 */
export function planReorder(
    queue: QueueEntry[],
    currentIndex: number,
    keys: readonly string[],
): QueuePlan | null {
    if (keys.length !== queue.length) return null

    const byKey = new Map(queue.map((entry) => [queueEntryKey(entry), entry]))
    const next: QueueEntry[] = []
    for (const key of keys) {
        const entry = byKey.get(key)
        if (!entry) return null
        next.push(entry)
    }

    if (currentIndex < 0 || currentIndex >= queue.length) return { queue: next, currentIndex }
    const currentKey = queueEntryKey(queue[currentIndex])
    const moved = next.findIndex((entry) => queueEntryKey(entry) === currentKey)
    return { queue: next, currentIndex: moved === -1 ? currentIndex : moved }
}

/**
 * 移除一项的规划。不移除当前曲的语义由调用方按 `removedIndex === currentIndex` 判定。
 * @returns null = 队列里没有该 key 的项
 */
export function planRemove(
    queue: QueueEntry[],
    currentIndex: number,
    key: string,
): { plan: QueuePlan; removedIndex: number } | null {
    const removedIndex = queue.findIndex((item) => queueEntryKey(item) === key)
    if (removedIndex === -1) return null

    const next = queue.filter((_, i) => i !== removedIndex)
    let index = currentIndex
    if (removedIndex < currentIndex) {
        index = currentIndex - 1
    } else if (removedIndex === currentIndex && next.length > 0 && index >= next.length) {
        // 移除的是当前曲 → 指针落到后一首上；已是最后一首则回退到新的末尾
        index = next.length - 1
    }

    return { plan: { queue: next, currentIndex: next.length ? index : -1 }, removedIndex }
}

/**
 * 摘掉队列里指向某首已删歌曲（`songs.id`）的条目，并修好 currentIndex。
 *
 * @returns null = 队列里没有指向它的条目（无变更）
 */
export function planDropSong(
    queue: QueueEntry[],
    currentIndex: number,
    songId: string,
): QueuePlan | null {
    const removedIndex = queue.findIndex((e) => isQueueRef(e) && e.id === songId)
    if (removedIndex === -1) return null
    const outcome = planRemove(queue, currentIndex, queueEntryKey(queue[removedIndex]))
    return outcome ? outcome.plan : null
}
