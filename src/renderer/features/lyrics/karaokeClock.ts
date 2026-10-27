/**
 * 逐字歌词的本地时钟基准。
 *
 * 职责边界：这里只维护基准，不持有任何定时器。播放时间 currentTime 只有
 * ~4Hz 的 timeupdate 粒度，逐字高亮要 60fps 平滑就得靠本地时钟外推；而外推必须
 * 由「正在渲染的组件」在自己的 rAF 里驱动——没有组件渲染时就不该有任何计算。
 *
 * 用法：引擎收到 currentTime 时调 syncKaraokeClock(ms) 校准；组件在 rAF 里调
 * getKaraokeTimeMs() 取当前预测时刻。
 */

let playStartRealTime = 0
let playStartPosition = 0
let lastSyncActualMs = 0
/** 时钟是否随真实时间外推。暂停时必须置 false，否则高亮会继续往前跑。 */
let running = true

/** 大漂移阈值：超过则硬同步（seek / 初始化 / 卡顿恢复）。 */
const HARD_SYNC_MS = 150
/** 小漂移阈值：超过则柔性校正，低于此值忽略，交给本地时钟。 */
const SOFT_SYNC_MS = 20
/** 柔性校正系数：只吃掉一部分偏差，避免进度条出现可见跳变。 */
const SOFT_SYNC_FACTOR = 0.4

/**
 * 用真实播放时间（毫秒）校准本地时钟。
 * 内部会比对预测值与真实值的漂移，按大小选择硬同步 / 柔性校正 / 忽略。
 */
export function syncKaraokeClock(actualMs: number): void {
    if (actualMs === lastSyncActualMs) return

    const now = performance.now()
    const predictedMs = playStartPosition + (now - playStartRealTime)
    const drift = actualMs - predictedMs

    if (Math.abs(drift) > HARD_SYNC_MS) {
        playStartRealTime = now
        playStartPosition = actualMs
    } else if (Math.abs(drift) > SOFT_SYNC_MS) {
        playStartPosition += drift * SOFT_SYNC_FACTOR
    }
    // 极小漂移：忽略，本地时钟足够准

    lastSyncActualMs = actualMs
}

/**
 * 切换时钟的「走 / 停」。
 *
 * 必须跟播放状态联动：暂停后 timeupdate 不再到达，而 `getKaraokeTimeMs()` 只按
 * `performance.now()` 外推——放任不管，暂停期间高亮会一路往前跑，恢复播放时再被硬
 * 同步拉回来（表现为「暂停还在唱、一点播放又跳回去」）。置 false 时把当前预测值原地
 * 冻结，恢复时以冻结点为新的起算点，位置不跳。
 */
export function setKaraokeClockRunning(next: boolean): void {
    if (next === running) return
    const now = performance.now()
    // 冻结到「最后一次真实时间」而不是外推值：timeupdate 只有 ~4Hz，用外推值会在暂停瞬间
    // 多跑出上百毫秒，恢复播放时再被硬同步拉回来。
    if (!next) playStartPosition = lastSyncActualMs
    playStartRealTime = now
    running = next
}

/** 当前预测播放时间（毫秒）。 */
export function getKaraokeTimeMs(): number {
    if (!running) return playStartPosition
    return playStartPosition + (performance.now() - playStartRealTime)
}

/** 重置基准（切歌 / 停止播放）。 */
export function resetKaraokeClock(): void {
    playStartRealTime = performance.now()
    playStartPosition = 0
    lastSyncActualMs = 0
}
