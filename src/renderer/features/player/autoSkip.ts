/**
 * 播放失败自动切换
 *
 * 由 `player.ts` 驱动（三个入口：`notePlaybackError` / `noteUserAction` / `noteSongStarted`），
 * 本模块只做判定 + 计时，不订阅事件、不拼提示文案 —— 文案留在 `player.ts` 那一处映射，
 * 避免同一件事弹两条消息。
 *
 * 四条「不跳」的边界：
 *  ① 错误属于「正常打断」（AbortError / NotAllowedError / MediaError code 1）—— 不是歌的问题；
 *  ② 设置关着；
 *  ③ 队列只有一首 —— 跳了还是它；
 *  ④ 失败的目标已不是当前曲 —— 用户早就切走了。
 *
 * 节奏：只有连续失败的第 1 次等（让用户看清被跳过的是哪首），其后立即跳。
 * 连续失败达上限则停下并提示。
 */
import { usePlayerStore, useQueueStore, useSettingsStore } from '@renderer/store'
import { rlog } from '@renderer/lib/log'

/** 首个失败的等待时长（ms） */
export const FIRST_FAILURE_DELAY_MS = 3000
/** 连续失败上限：试到第 3 首还不行就停，不再往前找 */
export const MAX_CONSECUTIVE_FAILURES = 3
/** 取消令牌上限，到顶回绕 */
export const TOKEN_LIMIT = 100


/**
 * 错误是否属于「这首歌 / 这条源本身播不了」—— 只有这类才值得跳下一首。
 *
 * 排除的三类都是「被打断 / 被策略拒绝」，不是资源的锅：
 *  - `AbortError`：`play()` 被新的装载顶掉，或被 `pause()` 打断（快速切歌时必然出现）；
 *  - `NotAllowedError`：自动播放策略拒绝，换一首歌同样会被拒；
 *  - MediaError `code === 1`（MEDIA_ERR_ABORTED）：取流被中止，同上。
 */
function isSkippableError(error: unknown): boolean {
    const name = (error as { name?: unknown } | null | undefined)?.name
    if (name === 'AbortError' || name === 'NotAllowedError') return false
    return (error as { code?: unknown } | null | undefined)?.code !== 1
}

/** 判定结果：跳 / 到顶停下 / 不该跳 */
type AutoSkipDecision = 'skip' | 'stop' | 'none'

interface AutoSkipInput {
    /** 设置开关 */
    enabled: boolean
    queueLength: number
    /** 失败的那个目标是否还是当前目标 */
    sameTarget: boolean
    /** 含本次在内的连续失败次数 */
    failureCount: number
    /** 错误是否属于可跳类（`isSkippableError`） */
    skippable: boolean
}

/** 该不该跳、跳还是停 */
function decideAutoSkip(i: AutoSkipInput): AutoSkipDecision {
    if (!i.skippable) return 'none'
    if (!i.enabled) return 'none'
    if (i.queueLength <= 1) return 'none'
    if (!i.sameTarget) return 'none'
    return i.failureCount >= MAX_CONSECUTIVE_FAILURES ? 'stop' : 'skip'
}

/** 取消令牌自增，到上限回绕 */
function nextToken(token: number): number {
    return token >= TOKEN_LIMIT ? 0 : token + 1
}

// ---------------------------------------------------------------------------
// 状态 + 接线
// ---------------------------------------------------------------------------

/** 调用方（`player.ts` 的 `notePlaybackError`）需要据此决定提示文案 */
type FailureOutcome =
    /** 连续第 1 次：提示（带「N 秒后自动切换」）+ 延迟跳 */
    | 'notify-and-skip'
    /** 其后的连续失败：立即跳，不提示 */
    | 'silent-skip'
    /** 到上限：本模块已提示「已停止自动切换」；本首的错误照常提示 */
    | 'exhausted'
    /** 不跳：错误照常提示 */
    | 'ignore'

/** 含本次在内的连续失败次数 */
let failureCount = 0
/** 取消令牌：用户操作 / 新的失败都会让它前进，待跳的定时器据此作废 */
let token = 0
let timer: number | null = null
let advance: (() => Promise<void>) | null = null

interface Snapshot {
    enabled: boolean
    queueLength: number
    currentSongId: string | null
}

function snapshot(): Snapshot {
    return {
        enabled: useSettingsStore.getState().settings['player.autoSkipOnError'],
        queueLength: useQueueStore.getState().queue.length,
        currentSongId: usePlayerStore.getState().currentSong?.id ?? null,
    }
}

/**
 * 失败目标是否「还是当前目标」。
 *
 * `targetId === null` 表示失败发生在「队列项解析不出歌」那条路径（`switchTo` 的 payload
 * 里 `song` 就是 null）—— 此时要求 currentSong 同样为空才算「还在原地」。
 */
function isSameTarget(targetId: string | null): boolean {
    const current = usePlayerStore.getState().currentSong?.id ?? null
    return targetId === null ? current === null : current === targetId
}

function clearTimer(): void {
    if (timer !== null) {
        window.clearTimeout(timer)
        timer = null
    }
}

/**
 * 定时器落点复核。
 *
 * 令牌相等不足以证明这次待跳仍然有效：令牌到顶会回绕（`TOKEN_LIMIT`），理论上可能撞号。
 * 所以落点再核一遍现场 —— 设置仍开、目标仍是当前曲、且仍停在 `stopped`（没有被别的流程接手）。
 */
function stillWorthSkipping(targetId: string | null): boolean {
    return (
        snapshot().enabled &&
        usePlayerStore.getState().state === 'stopped' &&
        isSameTarget(targetId)
    )
}

/**
 * 接线。`advance` 由 `player.ts` 传入其私有前进原语 ——
 * 不能传导出的 `playNext`，否则自动跳会被自己记成一次「用户操作」而互相取消。
 */
export function initAutoSkip(deps: { advance: () => Promise<void> }): void {
    advance = deps.advance
}

/**
 * 一次播放失败。返回调用方该怎么处理提示。
 */
export function notePlaybackError(song: LP.Song | null, error: unknown): FailureOutcome {
    // 新的失败顶掉上一次待跳
    clearTimer()
    token = nextToken(token)

    const snap = snapshot()
    const targetId = song?.id ?? null
    const decision = decideAutoSkip({
        enabled: snap.enabled,
        queueLength: snap.queueLength,
        sameTarget: isSameTarget(targetId),
        failureCount: failureCount + 1,
        skippable: isSkippableError(error),
    })
    if (decision === 'none') return 'ignore'

    failureCount++
    if (decision === 'stop') return 'exhausted'

    const delay = failureCount === 1 ? FIRST_FAILURE_DELAY_MS : 0
    const my = token
    timer = window.setTimeout(() => {
        timer = null
        if (my !== token) return
        if (!stillWorthSkipping(targetId)) {
            // 提示里已经说了「N 秒后自动切换」，这里却没切 → 必须留痕，否则用户只看到「它没跳」
            rlog.debug('[player] 自动切换已取消：现场已变（设置关闭 / 目标已非当前曲 / 已不在 stopped）')
            return
        }
        void advance?.()
    }, delay)
    return failureCount === 1 ? 'notify-and-skip' : 'silent-skip'
}

/**
 * 用户操作 —— 终止继续自动跳，并把连续失败计数归零。
 *
 * 只有「由用户发起的播放意图变化」才算（见 `player.ts` 各导出动词里的调用点）：
 * 播放 / 暂停 / 换歌 / 定位 / 队列被改动。音量、倍速、播放模式、加歌、拖拽排序不算。
 */
export function noteUserAction(): void {
    token = nextToken(token)
    failureCount = 0
    clearTimer()
}

/** 有歌真正起播了 → 连续失败计数归零 */
export function noteSongStarted(): void {
    failureCount = 0
    clearTimer()
}
