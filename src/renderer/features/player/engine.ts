import { toPlayableUrl } from '@renderer/lib/utils'


/**
 * 音频引擎
 */

/** 对外状态沿用既有四态 */
export type EngineState = PlayState

/** 已装载的那条源 */
export interface LoadedSource {
    /** `${songId}:${quality}` —— 认得出「装的是哪首歌的哪一档」 */
    key: string
    quality: Quality
    url: string
}

/** 引擎 → 宿主 的回调 */
export interface EngineSink {
    /** 一次 store 原子写入（对应原来散落的 `usePlayerStore.setState`） */
    patch(p: {
        state?: EngineState
        currentTime?: number
        duration?: number
        currentPlaybackQuality?: Quality | null
    }): void
    /** 跨窗 / 托盘用的 `PLAY.STATE` */
    emitPlayState(state: EngineState): void
    /** `PLAY.PROGRESS` */
    emitProgress(time: number): void
    /** 起播成功（`audio.play()` 已 resolve）→ 宿主发 `SONG_STARTED` */
    onStarted(): void
    /** 自然播完 */
    onEnded(): void
    /** `<audio>` 的 error 事件：引擎已置 stopped 并 emit PLAY.STATE；宿主负责剔除缓存 + 发 `PLAYER.ERROR` */
    onMediaError(error: MediaError | null): void
    /** `audio.play()` 被拒：引擎已置 stopped；宿主负责发 `PLAYER.ERROR` */
    onPlayRejected(error: unknown): void
}

let sink: EngineSink | null = null
let audio: HTMLAudioElement | null = null

// ---- 引擎内部状态 ----
let state: EngineState = 'stopped'
let loaded: LoadedSource | null = null
/** 用户指定的起播位置：流未加载时落在这里，src 就绪后兑现一次；已加载时恒为 null。 */
let pendingSeek: number | null = null
/** 代际：每次「作废 / 开始装载」+1。异步取链回来时代际不符 → 整条丢弃，绝不回写 */
let generation = 0

// ---- 宿主推进来的配置 ----
let volume = 1
let rate = 1

function S(): EngineSink {
    if (!sink) throw new Error('引擎未接线：宿主必须先调用 initEngine(sink)')
    return sink
}

/** 接线。宿主（`player.ts`）在模块加载时调用一次。 */
export function initEngine(s: EngineSink): void {
    sink = s
}

/** 推音量 / 倍速（只给的部分才覆盖）。元素已建则同步，未建则留到创建时应用。 */
export function configureAudio(next: { volume?: number; rate?: number }): void {
    if (next.volume !== undefined) volume = next.volume
    if (next.rate !== undefined) rate = next.rate
    if (audio) {
        audio.volume = volume
        audio.playbackRate = rate
    }
}

export function getState(): EngineState {
    return state
}

/** 是否已装载了「当前歌曲」的流 */
export function isLoaded(): boolean {
    return loaded !== null
}

/** 已装载那条源的实际音质 */
export function getLoadedQuality(): Quality | null {
    return loaded?.quality ?? null
}

/**
 * 当前播放位置。流未加载时返回 null
 */
export function position(): number | null {
    return loaded && audio ? audio.currentTime : null
}

/** 状态迁移。`extra` 用于「一次写入多个字段」的收尾（如 stop 同时归零时间） */
function transition(next: EngineState, emit: boolean, extra?: { currentTime?: number; duration?: number }): void {
    state = next
    S().patch({ state: next, ...extra })
    if (emit) S().emitPlayState(next)
}

/**
 * 由宿主直接落一个状态（不 emit）。
 * 用于宿主自己发现「没得播」而收尾的场景（如队列项解析失败）。
 */
export function setState(next: EngineState): void {
    transition(next, false)
}

/**
 * 作废当前流（切歌 / 停止 / 清空队列）：代际 +1，装载信息与挂起位置清空。
 * 一并把 `currentPlaybackQuality` 归 `null`
 */
export function invalidate(): void {
    generation++
    loaded = null
    pendingSeek = null
    S().patch({ currentPlaybackQuality: null })
}

/**
 * 开始装载：置 loading、停掉旧流、清时长；返回本次代际号。
 *
 * ⚠️ 不清 `pendingSeek` —— 用户指定的起点要等到装载完成时才兑现。
 * ⚠️ 不 emit `PLAY.STATE`（与现行一致：只有真正换了播放态才发）。
 */
export function beginLoad(): number {
    const a = el()
    generation++
    transition('loading', false)
    a.pause()
    S().patch({ duration: 0 })
    return generation
}

/**
 * 装载成功：记音质、赋 src、兑现挂起位置、记下已装载的源。
 * @returns false = 代际已过期（用户在取链途中切了歌 / 换了档），整条丢弃
 */
export function commitLoad(gen: number, source: LoadedSource): boolean {
    if (gen !== generation) return false

    const a = el()
    // 实际解析出的音质记录到 store（可能已因兜底替换）；链接校验在取源层完成，此处不再重复。
    S().patch({ currentPlaybackQuality: source.quality })
    a.src = toPlayableUrl(source.url)
    // 起播位置
    a.currentTime = pendingSeek ?? 0
    pendingSeek = null
    loaded = source
    return true
}

/**
 * 装载失败：置 stopped。
 * 不清 `pendingSeek` —— 用户重试时他指定的起点还在。代际过期则整个忽略。
 */
export function abortLoad(gen: number): void {
    if (gen !== generation) return
    transition('stopped', false)
}

/** `play()` 被「新的装载」顶掉、或被 `pause()` 打断时的拒绝名 —— 不是「播不了」 */
function isPlayAborted(e: unknown): boolean {
    return (e as { name?: unknown } | null | undefined)?.name === 'AbortError'
}

/**
 * 起播（含失败兜底）。
 *
 * ⚠️ 两条不上报的路径 —— 都是为了不把「正常的打断」谎报成播放失败
 * （症状：快速切歌时弹一条假「播放失败」）：
 *  - `AbortError`：`play()` 被新的装载顶掉，或被 `pause()` 打断。代际未变 ⇒ 是本轮自己
 *    被打断（用户按了暂停）→ 补一个 `paused` 收尾，否则状态会卡在 `loading`。
 *  - 代际已过期 ⇒ 这次失败属于上一轮装载（用户在异步途中切了歌），与新流程无关 →
 *    既不上报、也不改状态（否则会把新流程刚落的 `loading` 打回 `stopped`）。
 */
export async function start(): Promise<void> {
    const gen = generation
    try {
        const a = el()
        await a.play()
        S().onStarted()
    } catch (e) {
        if (isPlayAborted(e)) {
            if (gen === generation) settlePaused()
            return
        }
        if (gen !== generation) return
        transition('stopped', false)
        S().onPlayRejected(e)
    }
}

/** 归零重播 */
export function replay(): void {
    const a = el()
    a.currentTime = 0
    void a.play()
    S().onStarted()
}

/** 暂停 */
export function pause(): void {
    audio?.pause()
}

/** 停止并落到 paused —— 供「原本就没在播」的换档收尾。 */
export function settlePaused(): void {
    audio?.pause()
    transition('paused', true)
}

/**
 * 停止：归零 + 作废流
 */
export function halt(): void {
    if (audio) {
        audio.pause()
        audio.currentTime = 0
    }
    invalidate()
    // duration 必须一起归零：宿主只在「当前曲消失」时调它，后面不接 switchTo，没人替它清
    transition('stopped', true, { currentTime: 0, duration: 0 })
}

/**
 * 跳转。流未加载时位置挂起，由 `commitLoad` 兑现；
 * 已加载时直接写元素，并丢弃之前挂起的值。
 */
export function applySeek(time: number): void {
    if (loaded && audio) {
        audio.currentTime = time
        pendingSeek = null
    } else {
        pendingSeek = time
    }
}

/** 直接挂起一个起播位置（供「保持进度的换档」用，调用方保证顺序：先 invalidate 再挂） */
export function suspendSeek(time: number): void {
    pendingSeek = time
}

function el(): HTMLAudioElement {
    if (!audio) {
        audio = new Audio()
        audio.volume = volume
        audio.playbackRate = rate

        audio.addEventListener('play', () => {
            transition('playing', true)
        })
        audio.addEventListener('pause', () => {
            // 仅当处于 playing 时补 paused；src 切换触发的暂停不覆盖 loading/stopped。
            if (state === 'playing') transition('paused', true)
        })
        audio.addEventListener('timeupdate', () => {
            const t = audio!.currentTime
            S().patch({ currentTime: t })
            S().emitProgress(t)
        })
        audio.addEventListener('durationchange', () => {
            if (Number.isFinite(audio!.duration) && audio!.duration > 0) {
                S().patch({ duration: audio!.duration })
            }
        })
        audio.addEventListener('ended', () => {
            S().onEnded()
        })
        audio.addEventListener('error', () => {
            transition('stopped', true)
            S().onMediaError(audio!.error)
        })

    }
    return audio
}
