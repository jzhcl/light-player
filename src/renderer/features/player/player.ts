import { usePlayerStore, useQueueStore, useSettingsStore } from '@renderer/store'
import { isOk } from '@shared/result'
import { rlog } from '@renderer/lib/log'
import { message } from '@renderer/lib/message'
import { getSongById, getSongsByIds } from '@renderer/lib/db'
import { createSongFromPlugin } from '@renderer/features/song/songIngest'
import { enqueueCover } from '@renderer/features/song/coverPipeline'
import { recordPlay } from '@renderer/features/song/songPlayedStatsService'
import { isQueueRef, queueEntryKey, toQueueRef, type QueueEntry } from '@renderer/features/song/songKey'
import { getSongLink } from '@renderer/features/player/songLinkService'
import { invalidateLink } from '@renderer/features/player/linkCache'
import * as engine from '@renderer/features/player/engine'
import {
    FIRST_FAILURE_DELAY_MS,
    MAX_CONSECUTIVE_FAILURES,
    initAutoSkip,
    notePlaybackError,
    noteSongStarted,
    noteUserAction,
} from '@renderer/features/player/autoSkip'
import { dedupeEntries, planAdd, planRemove, planReorder } from '@renderer/features/player/queueModel'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { songDeleted } from '@renderer/lib/batchedEvents'
import { shuffle } from '@renderer/lib/utils'


/**
 * 播放引擎门面：对外只出这一个 `player` 单例。
 *
 * 分层：
 *  - `engine.ts`   —— `<audio>` 元素 + 显式状态机 + 代际 token，零业务依赖
 *  - `queueModel.ts` —— 队列演算纯函数
 *  - `songLinkService.ts` —— 取源层的门面
 *  - 本文件 —— 串联三者：读 store → 调 engine/取源 → 写 store；不认识插件、不认识取源算法
 *
 * 「用户操作」：
 * 各导出动词在入口调 `noteUserAction()` —— 用于终止待跳的自动切换并归零连续失败计数。
 */
export type { QueueEntry }

/**
 * 播放意图 —— 「显式播某一个资源」的入参（`playSong` 的形参）。
 *
 * `play()` 的语义是「播队列当前那一首、按全局首选音质」——不做资源选择；
 * 而本地页要表达的是「我就播这一个文件」。塞进 `play()` 就改了它的语义。
 */
export interface PlayIntent {
    /** 要播的歌：`playSong` 用它定位媒体资源，并把它立为「当前曲」 */
    song: LP.Song
    /**
     * 显式档位：只对这一次取链生效，不写全局设置。
     * 不传 = 按全局首选音质（就近回退）。本地页一行就是一个音质文件 —— 点哪一行就播哪一档。
     */
    quality?: Quality
}

engine.initEngine({
    patch: (p) => usePlayerStore.setState(p),
    emitPlayState: (s) => eventBus.emit(LP_EVENT['PLAY.STATE'], s),
    emitProgress: (t) => eventBus.emit(LP_EVENT['PLAY.PROGRESS'], t),
    onStarted: () => eventBus.emit(LP_EVENT['PLAYER.SONG_STARTED'], usePlayerStore.getState().currentSong),
    onEnded: () => {
        if (useSettingsStore.getState().settings['player.mode'] === 'single') {
            engine.replay()
            return
        }
        // 自然播完的续播走内部原语：它不是「用户操作」，不该去取消待跳的自动切换
        void advanceNext()
    },
    onMediaError: (error) => {
        const { currentSong, currentPlaybackQuality } = usePlayerStore.getState()
        // 播放失败最常见的原因是平台链接提前失效 → 剔除缓存，下次重取
        // 未装载（null）时剔除该歌的全部缓存链接 —— 不知道是哪一档，索性全清。
        if (currentSong) invalidateLink(currentSong.id, currentPlaybackQuality ?? undefined)
        eventBus.emit(LP_EVENT['PLAYER.ERROR'], { song: currentSong, error })
    },
    onPlayRejected: (error) => {
        eventBus.emit(LP_EVENT['PLAYER.ERROR'], { song: usePlayerStore.getState().currentSong, error })
    },
})

// 自动切换接手「同一个失败的目标」
initAutoSkip({ advance: advanceNext })

/**
 * 把「用户偏好」推给引擎：引擎不读 settings，音量 / 倍速得由这里喂。
 * 每次装载前同步一次（元素可能刚建），设置变化时再同步一次。
 */
function syncEngineConfig(): void {
    const settings = useSettingsStore.getState().settings
    engine.configureAudio({
        volume: settings['player.audio.volume'],
        rate: settings['player.audio.rate'],
    })
}


function readQueueState(): { queue: QueueEntry[]; currentIndex: number } {
    const { queue, currentIndex } = useQueueStore.getState()
    return { queue, currentIndex }
}

/** 原子写队列 + 指针：两者耦合，分开写会露出「指针指向不存在的项」的中间态 */
function writeQueue(queue: QueueEntry[], currentIndex: number): void {
    useQueueStore.getState().setQueue(queue, currentIndex)
}

// ---------------------------------------------------------------------------
// 歌曲解析
// ---------------------------------------------------------------------------

/** 往后预取几首的封面：连续播放切歌时不会先露占位图 */
const COVER_PREFETCH_AHEAD = 10

async function prefetchCoverAhead(): Promise<void> {
    const { queue, currentIndex } = readQueueState()
    if (currentIndex < 0) return
    const ids: string[] = []
    for (let i = currentIndex + 1; i < queue.length && ids.length < COVER_PREFETCH_AHEAD; i++) {
        const entry = queue[i]
        if (isQueueRef(entry)) ids.push(entry.id)
    }
    if (ids.length === 0) return
    const r = await getSongsByIds(ids)
    if (!isOk(r)) return
    for (const song of r.value) enqueueCover(song)
}

/**
 * 解析当前索引处的队列项为 LP.Song，写入 playerStore.currentSong。
 * 插件歌曲则先入库（createSongFromPlugin），并把队列项收敛为轻量身份载体（持久化）。
 * @returns 是否成功解析出可播放歌曲
 */
async function resolveCurrentSong(): Promise<boolean> {
    const { queue, currentIndex } = readQueueState()
    if (currentIndex < 0 || currentIndex >= queue.length) return false

    const item = queue[currentIndex]
    if (isQueueRef(item)) {
        const r = await getSongById(item.id)
        if (!isOk(r)) return false
        if (!r.value) return false
        usePlayerStore.getState().setCurrentSong(r.value)
        usePlayerStore.setState({ duration: r.value.duration })
        // 正在播的这首封面要马上用（播放页大图 / 桌面歌词），插队物化
        enqueueCover(r.value, 'high')
        void prefetchCoverAhead()
        return true
    }

    const r = await createSongFromPlugin(item)
    if (!isOk(r)) return false
    usePlayerStore.getState().setCurrentSong(r.value)
    usePlayerStore.setState({ duration: r.value.duration })
    enqueueCover(r.value, 'high')
    // 收敛成 QueueRef
    const newQueue = queue.slice()
    newQueue[currentIndex] = toQueueRef(r.value)
    writeQueue(newQueue, currentIndex)
    void prefetchCoverAhead()
    return true
}

// ---------------------------------------------------------------------------
// 播放控制
// ---------------------------------------------------------------------------

/**
 * 切到指定索引的歌曲（不记「用户操作」）。
 *
 * 解析歌曲信息但不加载音频流，成功则发 `SONG_CHANGED`；解析不出可播歌时置 `stopped`
 * 并发 `PLAYER.ERROR`（`song` 为 `null`）。
 *
 * @returns 是否解析成功
 */
async function switchToIndex(index: number): Promise<boolean> {
    const { queue } = readQueueState()
    if (index < 0 || index >= queue.length) return false
    writeQueue(queue, index)
    engine.invalidate()
    usePlayerStore.setState({ currentTime: 0, duration: 0 })
    const resolved = await resolveCurrentSong()
    if (!resolved) {
        usePlayerStore.getState().setCurrentSong(null)
        engine.setState('stopped')
        eventBus.emit(LP_EVENT['PLAYER.ERROR'], { song: null, error: new Error('无法解析队列中的歌曲') })
        return false
    }
    eventBus.emit(LP_EVENT['PLAYER.SONG_CHANGED'], usePlayerStore.getState().currentSong)
    return true
}

/** 切到指定索引的歌曲（用户操作：点列表行 / 点队列行） */
async function switchTo(index: number): Promise<void> {
    noteUserAction()
    await switchToIndex(index)
}

/**
 * 确保当前歌曲的音频流已加载：代际记账 → 取链 → 赋 src → 兑现 pendingSeek。
 * 失败时置 stopped 并 emit PLAYER.ERROR；返回是否成功。
 *
 * @param requestedQuality 显式音质：只对**这一次取链**生效，不写设置。
 *   仅「本地页点了某个具体文件」会传（一行就是一个音质文件，点哪行播哪档）；
 *   不传则走全局首选音质（就近回退）。流已加载时本参数不作数（不会重取链）。
 */
async function ensureStreamLoaded(requestedQuality?: Quality): Promise<boolean> {
    if (engine.isLoaded()) return true
    const song = usePlayerStore.getState().currentSong
    if (!song) return false

    syncEngineConfig()
    const gen = engine.beginLoad()

    const urlR = await getSongLink(song, requestedQuality)
    if (!isOk(urlR)) {
        // 不清 pendingSeek：用户重试时他指定的起点还在。
        engine.abortLoad(gen)
        eventBus.emit(LP_EVENT['PLAYER.ERROR'], { song, error: new Error(urlR.error) })
        return false
    }
    const { quality, url } = urlR.value
    return engine.commitLoad(gen, { key: `${song.id}:${quality}`, quality, url })
}

/**
 * 起播当前曲（不记「用户操作」）。
 *
 * 自动切换的前进路径必须走这里（或 `advanceTo`），不能走导出的 `play`。
 */
async function startPlayback(): Promise<void> {
    if (!usePlayerStore.getState().currentSong) {
        const { queue, currentIndex } = readQueueState()
        if (queue.length > 0 && currentIndex >= 0) {
            await resolveCurrentSong()
            engine.invalidate()
        }
        if (!usePlayerStore.getState().currentSong) return
    }

    if (!(await ensureStreamLoaded())) return
    await engine.start()
}

/**
 * 切到指定索引并起播（不记「用户操作」）。
 * 解析失败时 `switchToIndex` 已把状态收尾，这里不再往下走（否则会把同一首重新解析一遍）。
 */
async function advanceTo(index: number): Promise<void> {
    if (!(await switchToIndex(index))) return
    await startPlayback()
}

/** 前进一步（自然播完续播 / 自动切换共用） */
async function advanceNext(): Promise<void> {
    const { queue, currentIndex } = readQueueState()
    if (queue.length === 0) return
    const idx = currentIndex >= queue.length - 1 ? 0 : currentIndex + 1
    await advanceTo(idx)
}

/** 后退一步（内部原语） */
async function advancePrev(): Promise<void> {
    const { queue, currentIndex } = readQueueState()
    if (queue.length === 0) return
    const idx = currentIndex <= 0 ? queue.length - 1 : currentIndex - 1
    await advanceTo(idx)
}

/** 播放当前歌曲（用户操作：播放按钮 / 点歌 / 失败后手动重试） */
async function play(): Promise<void> {
    noteUserAction()
    await startPlayback()
}

/**
 * 播放指定的一首歌，并可显式指定这一次取链的档位。
 *
 * 与 `play()` 的分工：
 *  - `play()`     = 「播队列当前那一首，按全局首选音质」—— 不做资源选择；
 *  - `playSong()` = 「就播这一个资源」—— 歌与档位都由调用方给定。
 *
 * 队列指针不在这里* —— 需要它移动的调用方自己先 `setQueue` / `switchTo`。
 * 因此本函数是自足的：歌不同就立为新当前曲（发 `SONG_CHANGED`，系统媒体信息同步靠它），
 * 并作废旧流（否则 `ensureStreamLoaded` 会因「流已加载」短路，根本不换源）。
 */
async function playSong(intent: PlayIntent): Promise<void> {
    noteUserAction()
    const song = intent.song
    if (usePlayerStore.getState().currentSong !== song) {
        usePlayerStore.getState().setCurrentSong(song)
        usePlayerStore.setState({ currentTime: 0, duration: song.duration })
        engine.invalidate()
        eventBus.emit(LP_EVENT['PLAYER.SONG_CHANGED'], song)
    }
    if (!(await ensureStreamLoaded(intent.quality))) return
    await engine.start()
}

/**
 * 按当前全局首选音质对当前歌重新取链（保持进度与播放 / 暂停态）。
 *
 * 取链失败时只回滚这一次播放。
 */
async function reload(): Promise<void> {
    noteUserAction()
    if (!usePlayerStore.getState().currentSong) return
    const wasPlaying = usePlayerStore.getState().state === 'playing'
    // 未加载时元素上的 currentTime 属于上一首，不具意义 → 回退到 store
    const at = engine.position() ?? usePlayerStore.getState().currentTime
    engine.invalidate()
    // invalidate 会清掉 pendingSeek —— 所以必须在它之后设
    engine.suspendSeek(at)

    if (!(await ensureStreamLoaded())) return
    if (wasPlaying) {
        await engine.start()
        return
    }
    engine.settlePaused()
}

/** 暂停（用户操作） */
function pause(): void {
    noteUserAction()
    engine.pause()
}

async function togglePlay(): Promise<void> {
    if (usePlayerStore.getState().state === 'playing') {
        pause()
    } else {
        await play()
    }
}

/** 停止（用户操作：也被「移除当前曲」「清空队列」复用） */
function stop(): void {
    noteUserAction()
    engine.halt()
}

/** 上一首（用户操作） */
async function playPrev(): Promise<void> {
    noteUserAction()
    await advancePrev()
}

/** 下一首（用户操作） */
async function playNext(): Promise<void> {
    noteUserAction()
    await advanceNext()
}

/**
 * 定位到指定位置（不记「用户操作」）。
 *
 * 未加载态下 `store.currentTime` 的含义是「用户指定的起点」，而不是播放头 ——
 * 位置写不进 audio（它可能是 null，或还没有 src），由引擎挂起、起播时兑现。
 */
function applySeekTo(time: number): void {
    const duration = usePlayerStore.getState().duration
    let target = time
    if (target < 0) target = 0
    if (Number.isFinite(duration) && duration > 0 && target > duration) target = duration

    engine.applySeek(target)
    usePlayerStore.setState({ currentTime: target })
}

/** 跳转到指定位置（用户操作：点歌词行 / 拖进度条） */
function seekTo(time: number): void {
    noteUserAction()
    applySeekTo(time)
}

/**
 * 相对当前位置跳转（不记「用户操作」）。
 * @param delta 秒数，正为前进、负为后退；目标由 `applySeekTo` 夹到 [0, duration]。
 *
 * 基准的选取：流已加载时用 audio 的实际播放位置（而非 store.currentTime —— 它由
 * timeupdate ~4Hz 回写，连续快进时会读到滞后值，连点会丢步长）；流未加载时没人回写
 * store，它本身就是权威，因此恢复态下快进/快退同样可用。
 */
function seekBy(delta: number): void {
    const base = engine.position() ?? usePlayerStore.getState().currentTime
    applySeekTo(base + delta)
}

/**
 * 快进一段（默认 3 秒）。
 *
 * ⚠️ 故意不记「用户操作」：失败后那 3 秒等待窗里按快进不该把待跳的自动切换取消掉
 * （此时流已作废，快进本身也不会生效）。与「点歌词行定位」(`seekTo`) 分属两类。
 */
function forward(seconds: number = 3): void {
    seekBy(seconds)
}

/** 快退一段（默认 3 秒）。不记「用户操作」，理由同 `forward`。 */
function rewind(seconds: number = 3): void {
    seekBy(-seconds)
}

function setVolume(v: number): void {
    const vol = Math.min(1, Math.max(0, v))
    engine.configureAudio({ volume: vol })
    useSettingsStore.getState().setSetting('player.audio.volume', vol)
}

function setRate(r: number): void {
    const rate = Math.min(2, Math.max(0.5, r))
    engine.configureAudio({ rate })
    useSettingsStore.getState().setSetting('player.audio.rate', rate)
}

/** 播放模式的轮转顺序 */
export const NEXT_MODE: Record<PlayMode, PlayMode> = {
    loop: 'single',
    single: 'random',
    random: 'loop',
}

function setMode(mode: PlayMode): void {
    if (useSettingsStore.getState().settings['player.mode'] === mode) return
    useSettingsStore.getState().setSetting('player.mode', mode)
    if (mode === 'random') {
        const { queue, currentIndex } = readQueueState()
        if (queue.length <= 1 || currentIndex < 0 || currentIndex >= queue.length - 1) return
        const before = queue.slice(0, currentIndex + 1)
        const after = shuffle(queue.slice(currentIndex + 1))
        writeQueue([...before, ...after], currentIndex)
    }
}

// ---------------------------------------------------------------------------
// 队列操作
// ---------------------------------------------------------------------------

/**
 * 替换整个队列（不自动播放）。去重；随机模式下整体打乱。
 *
 * 去重与打乱都会移动下标，所以「源列表里的第 N 首」不能直接当队列下标用：
 * 传 `targetIndex` 进来，这里按那一项的唯一键在新队列里重新定位，并把结果返回给调用方。
 *
 * targetIndex 源列表里的下标；省略 = 不指定目标（队列指针落在队首）
 * @returns 目标曲在新队列里的下标；未命中 / 空队列返回「队首或 -1」，调用方据此决定要不要 switchTo
 */
function setQueue(ss: QueueEntry[], targetIndex?: number): number {
    noteUserAction()
    const mode = useSettingsStore.getState().settings['player.mode']
    const target = targetIndex !== undefined ? ss[targetIndex] : undefined
    const deduped = dedupeEntries(ss)
    const queue = mode === 'random' ? shuffle(deduped) : deduped
    const found = target ? queue.findIndex((entry) => queueEntryKey(entry) === queueEntryKey(target)) : -1
    const index = found >= 0 ? found : queue.length ? 0 : -1
    writeQueue(queue, index)
    if (queue.length) {
        usePlayerStore.setState({ currentSong: null })
        engine.invalidate()
    }
    return index
}

/**
 * 添加歌曲到队列。
 * @param ss 歌曲列表（内部按唯一键去重，保序）
 * @param pos 'begin' 队首 / 'current' 当前曲之后（默认） / 'end' 队尾
 *
 * 队列里已有的同 key 项先剔除（同曲重入不产生重复行）。
 */
function addToQueue(ss: QueueEntry[], pos: 'begin' | 'current' | 'end' = 'current'): void {
    if (!ss.length) return

    const { queue, currentIndex } = readQueueState()
    if (!queue.length) {
        const mode = useSettingsStore.getState().settings['player.mode']
        const list = dedupeEntries(ss)
        const newQueue = mode === 'random' ? shuffle(list) : list
        writeQueue(newQueue, 0)
        void switchToIndex(0)
        return
    }

    const plan = planAdd(queue, currentIndex, ss, pos)
    if (!plan) return
    writeQueue(plan.queue, plan.currentIndex)
}

/** 添加到「下一首」播放位置（currentIndex + 1）。 */
function addToNext(s: QueueEntry): void {
    const { queue, currentIndex } = readQueueState()
    if (!queue.length) {
        writeQueue([s], 0)
        void switchToIndex(0)
        return
    }

    const plan = planAdd(queue, currentIndex, [s], 'current')
    if (!plan) return
    writeQueue(plan.queue, plan.currentIndex)
}

/**
 * 重排队列（拖拽落定）。入参是新的全量 key 顺序。
 * 当前曲按 key 跟随 —— 重排只改它落在第几位，不改「正在播放的是哪一首」。
 */
function reorderQueue(keys: string[]): void {
    noteUserAction()
    const { queue, currentIndex } = readQueueState()
    if (!queue.length) return

    const plan = planReorder(queue, currentIndex, keys)
    if (!plan) return
    writeQueue(plan.queue, plan.currentIndex)
}

/**
 * 从队列移除指定歌曲，维护 currentIndex 与播放态。
 *
 * 移除的是「当前曲」且队列还有歌时：`planRemove` 已把指针挪到有效位（后一首顶上来；
 * 移除的是末位则回退到新的末位），这里直接切过去并解析成 currentSong ——
 * 否则 currentIndex 指着某一首、currentSong 却是 null，底栏就成了
 * 「未播放歌曲 + 上一首的时长」，而点播放又会按 currentIndex 起播另一首。
 * 原本在播就续播下一首。
 */
function removeFromQueue(s: QueueEntry): void {
    noteUserAction()
    const { queue, currentIndex } = readQueueState()
    if (!queue.length) return

    const outcome = planRemove(queue, currentIndex, queueEntryKey(s))
    if (!outcome) return

    const { queue: nextQueue, currentIndex: nextIndex } = outcome.plan
    writeQueue(nextQueue, nextIndex)

    if (!nextQueue.length) {
        stop()
        usePlayerStore.getState().setCurrentSong(null)
        return
    }
    if (outcome.removedIndex !== currentIndex) return

    // 移除的是当前曲：先停掉旧曲，再切到新指针处。
    const wasPlaying = usePlayerStore.getState().state === 'playing'
    stop()
    void switchToIndex(nextIndex).then(() => {
        if (wasPlaying) return play()
    })
}

/**
 * 启动恢复：把上次退出时的「当前曲」立为 currentSong，不自动播放；返回恢复到的歌（无可恢复时为 null）
 */
export async function restorePlayback(): Promise<LP.Song | null> {
    const { queue, currentIndex } = readQueueState()
    if (!queue.length || currentIndex < 0 || currentIndex >= queue.length) return null
    await switchToIndex(currentIndex)
    return usePlayerStore.getState().currentSong
}

function clearQueue(): void {
    noteUserAction()
    stop()
    writeQueue([], -1)
    usePlayerStore.getState().setCurrentSong(null)
}

export const player = {
    play,
    playSong,
    pause,
    stop,
    togglePlay,
    playPrev,
    playNext,
    seekTo,
    forward,
    rewind,
    switchTo,
    reload,
    setVolume,
    setRate,
    setMode,
    setQueue,
    addToQueue,
    addToNext,
    reorderQueue,
    removeFromQueue,
    clearQueue,
}

/**
 * 歌曲「开始播放」时记一次播放历史
 */
eventBus.on(LP_EVENT['PLAYER.SONG_STARTED'], (...args) => {
    const song = args[0] as LP.Song | null | undefined
    if (song?.id) void recordPlay(song.id)
})

/**
 * 有歌真正起播 → 连续失败计数归零。
 *
 * 这是自动切换的「成功即归零」：上一条能正常播的歌一旦响起来，说明之前那串失败已经中断，
 * 下一个新失败应当重新享有「首条等 3 秒 + 提示」的待遇。
 */
eventBus.on(LP_EVENT['PLAYER.SONG_STARTED'], () => noteSongStarted())

/** `<audio>` 的 MediaError.code → 可读文案 */
const MEDIA_ERROR_TEXT: Record<number, string> = {
    1: '播放被中止',
    2: '网络错误，音频流下载失败',
    3: '音频解码失败',
    4: '音频格式不支持或链接已失效',
}

/** 播放失败的原因 */
function failReason(error: unknown): string {
    const code = (error as { code?: unknown } | null | undefined)?.code
    if (typeof code === 'number') return MEDIA_ERROR_TEXT[code] ?? `媒体错误（code ${code}）`
    if (error instanceof Error) return error.message || error.name
    return String(error)
}

/** 日志与提示里的歌曲身份；解析不出歌时「是哪首」本身就是结论 */
function songLabel(song: LP.Song | null): string {
    return song ? `${song.name}-${song.singer}` : '当前歌曲'
}

/**
 * 「静默失败」—— `AbortError` 是被新的装载 / `pause()` 顶掉的，不是歌播不了。
 * 快速切歌时它必然出现，提示了就是满屏假「播放失败」。
 */
function isSilentFailure(error: unknown): boolean {
    return (error as { name?: unknown } | null | undefined)?.name === 'AbortError'
}

/**
 * 播放失败 → 日志 + 提示用户 + 交给自动切换判定下一步。
 *
 * `PLAYER.ERROR` 有四个发射点：
 * 取链接失败 / 解析歌曲失败 / audio 元素 error / play() 抛错。
 *
 * 两类错误分开措辞：
 *  - 业务错误（`getSongLink` 的 `fail`、`resolveCurrentSong` 的失败）走 `Error.message`，
 *    原文就是中文、已是给用户看的（如「本地文件已丢失：X」）。
 *  - 媒体错误（`<audio>` 的 `MediaError`）带数字 `code`，映射成可读文案。
 */
eventBus.on(LP_EVENT['PLAYER.ERROR'], (...args) => {
    const payload = args[0] as { song?: LP.Song | null; error?: unknown } | undefined
    const error = payload?.error
    const song = payload?.song ?? null
    // 先交给自动切换：它要维护取消令牌与连续失败计数。判「要不要提示」不能改变这个顺序
    const outcome = notePlaybackError(song, error)
    const label = songLabel(song)
    const reason = failReason(error)

    if (isSilentFailure(error)) {
        rlog.debug(`[player] 播放中断（不计失败）：${label} → ${reason}`)
        return
    }

    const delaySec = FIRST_FAILURE_DELAY_MS / 1000
    switch (outcome) {
        case 'notify-and-skip':
            rlog.warn(`[player] 播放失败，${delaySec}s 后自动切换下一首：${label} → ${reason}`)
            message.warn(`播放失败：${label}（${reason}），${delaySec} 秒后自动切换下一首`)
            break
        case 'silent-skip':
            rlog.warn(`[player] 播放失败，立即切换下一首（连续失败中）：${label} → ${reason}`)
            break
        case 'exhausted':
            rlog.error(
                `[player] 播放失败，连续 ${MAX_CONSECUTIVE_FAILURES} 首失败已停止自动切换：${label} → ${reason}`,
            )
            message.error(
                `播放失败：${label}（${reason}）；`
                + `已连续 ${MAX_CONSECUTIVE_FAILURES} 首失败，已停止自动切换`,
            )
            break
        case 'ignore':
            rlog.warn(`[player] 播放失败：${label} → ${reason}`)
            message.error(`播放失败：${label}（${reason}）`)
            break
    }
})

// 歌曲从资料库删除（songs 表无记录）：若正在播放该曲则停止媒体，避免继续播已不存在的文件导致 UI 异常。
songDeleted.subscribe((ids) => {
    const cur = usePlayerStore.getState().currentSong
    if (cur && ids.includes(cur.id)) stop()
})
