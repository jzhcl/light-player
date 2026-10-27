import { useSyncExternalStore } from 'react'
import { isOk } from '@shared/result'
import { normalizePath } from '@shared/utils'
import { rlog } from '@renderer/lib/log'
import { getLocalSongsAll } from './db/song'
import { existsMany } from './file'
import { scheduleIdleLoop } from './idle'

/**
 * 资料库「本地文件是否存在」检查（模块单例，不是 zustand store）。
 *
 * 解决什么：本地与下载页里的文件行，用户事先看不出哪些文件已经不在磁盘上了。
 *
 * - 档位只管「启动全量扫描」这一件事：三个时长是它的节流窗口，`'never'` = 永不全量。
 *   它不开关提示层 —— 任何档位都要恢复上次结论（与资料库求交后照灰）、都要接运行期写入。
 * - 只在启动时全量扫一次，运行期不再扫描。扫到的缺失在本次运行期内一直算缺失。
 * - `'never'` 下不做「复查已标记的缺失」（见下条）：一次盘都不碰 → 被放回磁盘的文件
 *   不会被自动发现，要等用户播一次（`playFrom` / `getSongLink` 都会探并清标记）。
 *   这是刻意的：「恢复自愈」是 6h/1d/3d 才有的服务。
 * - 500 是「启动扫描层」的配额，不是存储上限。运行期（playFrom）发现的缺失记到另一个
 *   不设上限的层里 —— 否则配额占满后，运行期再发现坏文件就没地方记了。
 * - 配额满 ≠ 不灰化。扫描层里已记的 500 条照常灰化；满的是「继续扫新的」这件事。
 * - 启动时扫描层就已满 → 连预扫描都不做（文件系统经历过重大改动的退化态），
 *   但已存的 500 条仍然恢复并灰化（所以恢复动作排在配额判断之前）。
 * - 节流：距上次全量扫描不足设置里的间隔就不重跑全量（贵，与资料库规模成正比），
 *   改成只复查已标记为缺失的路径（便宜，与缺失数成正比）—— 「用户把文件放回去了」
 *   依然能被发现，只有「新出现的缺失」要等下一个窗口（那本来也该由播放那一刻兜底）。
 * - 两层都要能清除：playFrom 校验时探到文件其实在、或重新下载完成，都要把陈旧标记
 *   抹掉。否则行会一直灰到重启。
 *
 * ## 与其他层的关系
 *
 * ⚠️ 这里只是「提示层」，不是判据层。缓存里没标记 ≠ 文件在（可能没扫到 / 刚被删）。
 * 真正的判定在播放那一刻（`songLinkService.getSongLink` 的 `isFileExists`），两者职责不重叠。
 *
 * 运行期写入方有两处，互补而非冗余（`LocalDownloadPage.playFrom` 探到缺失时提前 return，
 * 压根不会走到 `getSongLink`）：
 *  - `songLinkService.getSongLink` —— 全 app 唯一的取链入口（`player.ts` 的 `play()`），
 *    覆盖所有页面 + 自动切歌；
 *  - `LocalDownloadPage.playFrom` —— 缺文件时它自己就拦下了，`getSongLink` 跑不到。
 *
 * 消费方读**并集**（`useMissingPaths`）。用 `useSyncExternalStore` 而不是 zustand：
 * 集合每批可能变一次（30 条），走 store 会把整页重渲染、打穿 `ListView` 的行级 memo。
 *
 * ⚠️ 间隔由调用方（`main.tsx` 读设置）传给 `initLocalFileCheck`，本模块不依赖
 * settingsStore —— 一是避免数据库/设置层把模块拖进循环依赖，二是逻辑探针能直接跑。
 */

/** 扫描间隔档位（与 `LP.RendererSetting['localFile.checkInterval']` 同源） */
export type LocalFileCheckInterval = LP.RendererSetting['localFile.checkInterval']

/** 真的会扫描的档位 —— `'never'` 不在其中 */
type ScannedInterval = Exclude<LocalFileCheckInterval, 'never'>

/**
 * 各档位的节流窗口长度（毫秒）。
 */
const INTERVAL_MS: Record<ScannedInterval, number> = {
    '6h': 6 * 60 * 60 * 1000,
    '1d': 24 * 60 * 60 * 1000,
    '3d': 3 * 24 * 60 * 60 * 1000,
}

/** 设置页用的档位清单 */
export const CHECK_INTERVALS: LocalFileCheckInterval[] = ['6h', '1d', '3d', 'never']

/** 启动扫描层的配额：一次全量扫描最多记这么多条缺失 */
const SCAN_QUOTA = 500

/**
 * 每批探测条数。
 * ⚠️ 真实并发度由 libuv 线程池决定（默认 4），批开大只减少 IPC 往返与空闲回调次数，
 * 磁盘总耗时几乎不变；且 `Promise.all` 要整批全回来才写结果 → 批越大首批灰化越晚。
 */
const BATCH_SIZE = 30

/** 落盘防抖：扫描期间每批都会改集合，逐批同步写 localStorage 会有几十次 JSON 序列化 */
const PERSIST_DEBOUNCE_MS = 1000

const STORAGE_KEY = 'localFileCheck.state'

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

/** 启动扫描层（受 `SCAN_QUOTA` 约束） */
const scanMissing = new Set<string>()
/** 运行期层（playFrom 写入，不占扫描配额） */
const runtimeMissing = new Set<string>()
/** 上次全量扫描完成时刻（0 = 从未扫过） */
let scannedAt = 0
/** 当前生效的节流窗口（由 `initLocalFileCheck` 按设置写入；`'never'` 下不参与比较） */
let throttleMs = INTERVAL_MS['6h']
let initialized = false

const listeners = new Set<() => void>()
let snapshot: ReadonlySet<string> = new Set()

function notify(): void {
    snapshot = new Set<string>([...scanMissing, ...runtimeMissing])
    for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
    listeners.add(fn)
    return () => {
        listeners.delete(fn)
    }
}

function getSnapshot(): ReadonlySet<string> {
    return snapshot
}

/**
 * 订阅「缺失文件路径集合」。
 * 返回的是两层并集的快照，引用稳定 —— 只在集合真的变化时换新对象。
 */
export function useMissingPaths(): ReadonlySet<string> {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// ---------------------------------------------------------------------------
// 落盘（localStorage；缓存不是用户设置，所以不挂 settingsStore）
// ---------------------------------------------------------------------------

interface PersistedState {
    scannedAt: number
    scanMissing: string[]
    runtimeMissing: string[]
}

function readStorage(): PersistedState | null {
    if (typeof localStorage === 'undefined') return null
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as Partial<PersistedState> | null
        if (!parsed) return null
        const strings = (v: unknown): string[] =>
            Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
        return {
            scannedAt: typeof parsed.scannedAt === 'number' ? parsed.scannedAt : 0,
            scanMissing: strings(parsed.scanMissing),
            runtimeMissing: strings(parsed.runtimeMissing),
        }
    } catch (e) {
        return null
    }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null

function writeNow(): void {
    if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
    }
    if (typeof localStorage === 'undefined') return
    try {
        const state: PersistedState = {
            scannedAt,
            scanMissing: [...scanMissing],
            runtimeMissing: [...runtimeMissing],
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch (e) {
    }
}

function persistSoon(): void {
    if (typeof localStorage === 'undefined') return
    if (persistTimer !== null) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
        persistTimer = null
        writeNow()
    }, PERSIST_DEBOUNCE_MS)
}

// ---------------------------------------------------------------------------
// 运行期写入（供 playFrom / 下载完成后调用）
// ---------------------------------------------------------------------------

/**
 * 记一条「运行期发现」的缺失（取链 / 播放前校验出来的）。
 *
 * 记到运行期层，不占启动扫描的 500 配额。
 */
export function markFileMissing(path: string): void {
    const key = normalizePath(path)
    if (!key) return
    if (scanMissing.has(key) || runtimeMissing.has(key)) return
    runtimeMissing.add(key)
    notify()
    writeNow()
}

/**
 * 文件确认存在 → 清掉陈旧标记
 */
export function clearFileMissing(path: string): void {
    const key = normalizePath(path)
    if (!key) return
    const fromScan = scanMissing.delete(key)
    const fromRuntime = runtimeMissing.delete(key)
    if (!fromScan && !fromRuntime) return
    notify()
    writeNow()
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/** 探测目标：`raw` 交给主进程探测，`key` 作为存储键 */
interface Target {
    raw: string
    key: string
}

let cancelScan: (() => void) | null = null

function stopScan(): void {
    cancelScan?.()
    cancelScan = null
}

/**
 * 分批探测。`onBatch` 返回 `false` 表示中止（`onDone` 仍会调）。
 *
 * ⚠️ 每批的 `existsMany` 是异步的，所以「本批结果写回」发生在微任务里 ——
 * 收工判定要同时看「批次是否派发完」与「是否还有在飞的批次」，缺一不可。
 */
function probeInBatches(
    targets: Target[],
    onBatch: (keys: string[], present: boolean[]) => boolean,
    onDone?: () => void,
): void {
    stopScan()
    if (targets.length === 0) {
        onDone?.()
        return
    }

    let cursor = 0
    let inFlight = 0
    let aborted = false
    let dispatchDone = false

    const finish = () => {
        cancelScan = null
        onDone?.()
    }

    cancelScan = scheduleIdleLoop(() => {
        if (aborted || cursor >= targets.length) {
            dispatchDone = true
            if (inFlight === 0) finish()
            return false
        }
        const batch = targets.slice(cursor, cursor + BATCH_SIZE)
        cursor += batch.length
        inFlight++
        void (async () => {
            try {
                const results = await existsMany(batch.map((t) => t.raw))
                const keys = batch.map((t) => t.key)
                const present = batch.map((_, i) => results[i] === true)
                if (onBatch(keys, present) === false) aborted = true
            } catch (e) {
            } finally {
                inFlight--
                if (dispatchDone && inFlight === 0) finish()
            }
        })()
        // 派发完最后一批后再回一次收工分支（这里不直接 finish，因为结果还没写回）
        return true
    })
}

/** 全量扫描：探测全部目标，缺失进扫描层（受 `SCAN_QUOTA` 约束），探到存在的顺手清除 */
function startFullScan(targets: Target[]): void {
    probeInBatches(
        targets,
        (keys, present) => {
            let changed = false
            for (let i = 0; i < keys.length; i++) {
                const key = keys[i]
                if (present[i]) {
                    // 上次扫描到现在恢复了 → 清掉陈旧标记
                    const fromScan = scanMissing.delete(key)
                    const fromRuntime = runtimeMissing.delete(key)
                    if (fromScan || fromRuntime) changed = true
                    continue
                }
                if (runtimeMissing.has(key) || scanMissing.has(key)) continue
                // 配额满 → 不再记新条目（已派发批次的异步结果同样被这一行挡住）
                if (scanMissing.size >= SCAN_QUOTA) continue
                scanMissing.add(key)
                changed = true
            }
            if (changed) {
                notify()
                persistSoon()
            }
            return scanMissing.size < SCAN_QUOTA
        },
        () => {
            scannedAt = Date.now()
            writeNow()
            // 扫描结束是唯一能拿到「最终缺失数」的时刻
            const capped =
                scanMissing.size >= SCAN_QUOTA ? `（已到配额上限 ${SCAN_QUOTA}，未继续统计）` : ''
            rlog.info(`[localfile] 全量扫描完成：检查 ${targets.length} 个，缺失 ${scanMissing.size} 个${capped}`)
        },
    )
}

/** 只复查「已标记为缺失」的路径是否恢复（节流窗口内用） */
function recheckKnownMissing(targets: Target[]): void {
    const byKey = new Map(targets.map((t) => [t.key, t]))
    const probe: Target[] = []
    const push = (key: string) => {
        const t = byKey.get(key)
        if (t) probe.push(t)
    }
    for (const key of scanMissing) push(key)
    for (const key of runtimeMissing) push(key)
    if (probe.length === 0) return

    probeInBatches(
        probe,
        (keys, present) => {
            let changed = false
            for (let i = 0; i < keys.length; i++) {
                if (!present[i]) continue
                const fromScan = scanMissing.delete(keys[i])
                const fromRuntime = runtimeMissing.delete(keys[i])
                if (fromScan || fromRuntime) changed = true
            }
            if (changed) {
                notify()
                persistSoon()
            }
            return true
        },
        writeNow,
    )
}

/** 从资料库取全部「落在磁盘上的文件路径」（key = 归一化，value = 原始路径） */
async function collectTargets(): Promise<Map<string, string>> {
    const byKey = new Map<string, string>()
    const r = await getLocalSongsAll()
    if (!isOk(r)) {
        return byKey
    }
    // ⚠️ 两条路都是 `downloadQualities[].path` —— 本机导入（pluginId='local'）时
    // `pluginSongId === downloadQualities[0].path`，所以不需要区分 pluginId。
    for (const song of r.value) {
        for (const q of song.downloadQualities ?? []) {
            const key = normalizePath(q.path)
            if (key && !byKey.has(key)) byKey.set(key, q.path)
        }
    }
    return byKey
}

/**
 * 启动初始化。
 *
 * 时序：取资料库路径 → 读缓存并与当前资料库求交（丢掉已删除歌曲的陈旧条目）→
 * 恢复并立刻 notify（配额满也要灰化已存的那些）→ `'never'` 到此为止
 * → 配额满则不再预扫描 → 节流窗口内只复查已标记的缺失 → 否则跑一次全量扫描。
 */
export async function initLocalFileCheck(interval: LocalFileCheckInterval): Promise<void> {
    if (initialized) {
        rlog.debug('[localfile] 本次跳过：已经初始化过')
        return
    }
    initialized = true

    // `'never'` 只表示「不做启动全量扫描」，不等于关闭提示层 —— 缓存恢复与运行期写入照常
    if (interval !== 'never') {
        throttleMs = INTERVAL_MS[interval]
    }

    const targets = await collectTargets()
    if (targets.size === 0) {
        rlog.info('[localfile] 本次跳过：没有需要检查的本地文件')
        return
    }

    const saved = readStorage()
    if (saved) {
        scannedAt = saved.scannedAt
        for (const key of saved.scanMissing) if (targets.has(key)) scanMissing.add(key)
        for (const key of saved.runtimeMissing) if (targets.has(key)) runtimeMissing.add(key)
        // 在配额判断之前 notify：配额满时页面仍要把已存的那些行灰掉
        if (scanMissing.size > 0 || runtimeMissing.size > 0) notify()
    }

    if (interval === 'never') {
        rlog.info(`[localfile] 本次不扫描（档位 never），沿用缓存：缺失 ${scanMissing.size} 个`)
        return
    }

    // 扫描层已满配额 → 文件系统经历过重大改动的退化态，不再预扫描（交给用户主动播放去试）
    if (scanMissing.size >= SCAN_QUOTA) {
        rlog.warn(`[localfile] 本次不预扫描：缺失已到配额上限 ${SCAN_QUOTA} 条`)
        return
    }

    const list: Target[] = [...targets].map(([key, raw]) => ({ raw, key }))

    if (scannedAt > 0 && Date.now() - scannedAt < throttleMs) {
        rlog.debug(`[localfile] 本次只复查已标记的缺失项 ${list.length} 个（节流窗口内）`)
        recheckKnownMissing(list)
        return
    }
    rlog.info(`[localfile] 本次全量扫描 ${list.length} 个文件`)
    startFullScan(list)
}
