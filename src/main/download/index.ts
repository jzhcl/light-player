import { type BrowserWindow } from 'electron'
import { ElectronDownloadManager } from 'electron-dl-manager'
import { randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { db } from '@main/db'
import { LP_EVENT } from '@shared/event'
import { log } from '@main/log'
import { formatError } from '@shared/result'


/** 主进程 -> 渲染进程的推送通道回调。 */
export type DownloadEmitter = (channel: string, payload: unknown) => void

export type NewDownloadTask = Omit<
    DownloadTask,
    'id' | 'libId' | 'status' | 'createdAt' | 'error' | 'progress' | 'downloadedBytes' | 'totalBytes' | 'downloadSpeed'
> & { id?: string }

export interface DownloadManagerApi {
    /** 加入下载队列，返回任务 id */
    add(input: NewDownloadTask, window: BrowserWindow): string

    /** 批量加入下载队列：原子创建所有任务后统一调度，返回各任务 id（顺序与入参一致） */
    addBatch(inputs: NewDownloadTask[], window: BrowserWindow): string[]

    pause(id: string): boolean

    resume(id: string): boolean

    remove(id: string): boolean

    list(): DownloadTask[]

    /** 未完成任务（下载中 / 已暂停 / 排队中）。 */
    listUnfinished(): DownloadTask[]

    /** 把给定任务的下载记录标成 `cancelled`，返回实际更新行数。 */
    markRecordsCancelled(ids: string[]): number

    setEmitter(emit: DownloadEmitter): void

    /** 退出前取消所有未完成任务（下载中 / 已暂停 / 排队中） */
    cancelAllPending(): void
}

interface InternalTask extends DownloadTask {
    window: BrowserWindow
}

const MAX_CONCURRENT = 3

export function createDownloadManager(emit?: DownloadEmitter): DownloadManagerApi {
    const lib = new ElectronDownloadManager()
    const tasks = new Map<string, InternalTask>()
    const queue: string[] = []
    let emitter: DownloadEmitter | undefined = emit
    const active = new Set<string>()
    // 待暂停集合：任务正在建立连接（status=downloading 但 libId 尚未下发，如断网 socket 连接阶段）
    // 时用户点了暂停，此时 lib.pauseDownload 无 libId 可调用，先标记，等 libId 到位立即暂停。
    const pendingPauses = new Set<string>()

    // 超时控制：连接超时（开始下载后长时间连不上）+ 停滞超时（下载中长时间无数据）。
    // 避免断网/弱网时任务永久卡在 downloading 不翻 failed。
    const CONNECT_TIMEOUT = 20_000
    const STALL_TIMEOUT = 20_000
    const timers = new Map<string, { connect?: ReturnType<typeof setTimeout>; stall?: ReturnType<typeof setTimeout> }>()
    const doneTasks = new Set<string>()
    const clearTimers = (id: string) => {
        const t = timers.get(id)
        if (!t) return
        if (t.connect) clearTimeout(t.connect)
        if (t.stall) clearTimeout(t.stall)
        timers.delete(id)
    }

    const setEmitter = (e: DownloadEmitter) => {
        emitter = e
    }
    const push = (channel: string, payload: unknown) => emitter?.(channel, payload)
    // 仅推送三个事件：开始 / 完成 / 失败（进度与状态由渲染侧主动查询，不推送）。
    const emitStarted = (t: InternalTask) => push(LP_EVENT['DOWNLOAD.STARTED'], toPublic(t))
    const emitCompleted = (t: InternalTask) => push(LP_EVENT['DOWNLOAD.COMPLETED'], toPublic(t))
    const emitFailed = (t: InternalTask) => push(LP_EVENT['DOWNLOAD.FAILED'], toPublic(t))

    const toPublic = (t: InternalTask): DownloadTask => {
        const { window, ...rest } = t
        void window
        return rest
    }

    // ---- 并发调度：任务一律先入 waiting 队列，pump() 有空位才进入 downloading ----
    const pump = () => {
        while (active.size < MAX_CONCURRENT && queue.length > 0) {
            const id = queue.shift()!
            const t = tasks.get(id)
            if (!t || t.status !== 'waiting') continue
            active.add(id)
            void startLib(t)
        }
    }

    // 全部任务处理完毕（无 waiting/downloading/paused，仅 completed/failed）时通知一次。
    // 加 allDoneNotified 防重：completed/failed 任务仍留在 tasks，finishTask 不会再次触发前先复位。
    let allDoneNotified = false
    const maybeEmitAllDone = () => {
        if (allDoneNotified) return
        const all = [...tasks.values()]
        if (all.length === 0) return
        const unfinished = all.some((t) => t.status === 'waiting' || t.status === 'downloading' || t.status === 'paused')
        if (unfinished) return
        allDoneNotified = true
        const failed = all.filter((t) => t.status === 'failed').length
        push(LP_EVENT['DOWNLOAD.ALL_DONE'], { failed })
        // 释放终端任务占用的内存。
        // 仅在 ALL_DONE 发出后才清理，保证本轮 failed 计数与「全部完成」提示不受影响。
        for (const t of all) {
            if (t.status === 'completed' || t.status === 'failed') {
                tasks.delete(t.id)
                doneTasks.delete(t.id)
            }
        }
    }

    const finishTask = (id: string) => {
        active.delete(id)
        pump()
        maybeEmitAllDone()
    }

    // 收尾（completed / failed）：超时 / onError / onDownloadInterrupted 等多路径防重入由 doneTasks 守卫。
    // 提到 manager 作用域，使 startLib 的连接超时也能复用。
    const settle = (t: InternalTask, status: DownloadStatus, error?: string) => {
        if (doneTasks.has(t.id)) return
        doneTasks.add(t.id)
        clearTimers(t.id)
        t.status = status
        t.error = error
        if (status === 'completed') {
            t.progress = 1
            t.downloadedBytes = t.totalBytes
            t.downloadSpeed = 0
            emitCompleted(t)
        } else {
            // 所有失败路径（连接超时 / 停滞超时 / 中断 / 引擎 onError）都汇到这里
            log.warn(`[download] ${t.filename} 下载失败：${error ?? '未知原因'}\nurl: ${t.url}`)
            // 失败即现场失效：引擎已经把这次下载从自己那里清掉，留着 libId 再 resume 只会
            // 静默 no-op（任务永远卡在 downloading）。复位后 resume() 走全新下载。
            t.libId = undefined
            // ⚠️ 这里不要立刻删文件：实测此刻 Chromium 仍持有句柄，unlink 必 EPERM
            // （operation not permitted），而引擎随后会自己删掉。
            // 万一没删干净，交由渲染端启动清理扫 `failed` 记录兜底。
            emitFailed(t)
        }
        finishTask(t.id)
    }

    // ---- 库回调 ----
    const buildCallbacks = (t: InternalTask) => {
        return {
            onDownloadStarted: (d: { item?: Electron.DownloadItem; resolvedFilename?: string }) => {
                t.downloadedBytes = d.item?.getReceivedBytes() ?? 0
                t.totalBytes = d.item?.getTotalBytes() ?? 0
                // 钳到 [0,1]：库在总大小未知时会回传负进度（如 -1），直接除会算出 -0.01
                t.progress = t.totalBytes > 0 ? Math.max(0, Math.min(1, t.downloadedBytes / t.totalBytes)) : 0
                // 仅活跃下载态才重置停滞窗口：暂停后的引擎回调（异步、可能晚到）不得重新武装计时器
                if (t.status !== 'downloading') return
                clearTimers(t.id) // 连接已建立，取消连接超时
                const stall = setTimeout(() => settle(t, 'failed', '下载超时（长时间无数据）'), STALL_TIMEOUT)
                timers.set(t.id, { stall })
            },
            onDownloadProgress: (d: {
                item?: Electron.DownloadItem
                percentCompleted: number
                downloadRateBytesPerSecond?: number
            }) => {
                t.downloadedBytes = d.item?.getReceivedBytes() ?? 0
                t.totalBytes = d.item?.getTotalBytes() ?? 0
                // 钳到 [0,1]
                t.progress = Math.max(0, Math.min(1, d.percentCompleted / 100))
                t.downloadSpeed = d.downloadRateBytesPerSecond ?? 0
                // 仅活跃下载态才维护停滞计时
                if (t.status !== 'downloading') return
                // 有数据流动 → 重置停滞计时
                const cur = timers.get(t.id) ?? {}
                if (cur.stall) clearTimeout(cur.stall)
                cur.stall = setTimeout(() => settle(t, 'failed', '下载超时（长时间无数据）'), STALL_TIMEOUT)
                timers.set(t.id, cur)
            },
            onDownloadCompleted: () => settle(t, 'completed'),
            onDownloadCancelled: () => {
                // 取消即移除任务（含无效 URL 等库内取消），不推送事件（渲染侧以 list 感知）。
                clearTimers(t.id)
                doneTasks.delete(t.id)
                tasks.delete(t.id)
                finishTask(t.id)
            },
            onDownloadInterrupted: () => settle(t, 'failed', '下载中断'),
            onError: (err: Error) => settle(t, 'failed', err.message),
        }
    }

    const startLib = async (t: InternalTask) => {
        t.status = 'downloading'
        t.error = undefined
        // 主进程状态机同步把 downloading 落库
        // 单处跃迁写（每任务进下载 1 次）；DB 写失败不应阻断下载启动，故吞掉异常。
        try {
            db.update('download_records', { id: t.id }, { status: 'downloading' })
        } catch (e) {
            log.warn(`[download] 记录 ${t.id} 落 downloading 失败\n${formatError(e)}`)
        }
        emitStarted(t)
        doneTasks.delete(t.id)
        clearTimers(t.id) // 防御：清掉该 id 上一生命周期可能残留的计时器
        // 进入下载态即重新计算超时：连接超时（CONNECT_TIMEOUT 内未建立连接）+ 停滞超时（STALL_TIMEOUT 内无数据）。
        // 二者都在 startLib 起算，确保「暂停后停止计时、恢复后从头计时」；onDownloadStarted 会清连接超时并重置停滞窗口，
        // onDownloadProgress 持续重置停滞窗口。
        const connect = setTimeout(() => settle(t, 'failed', '连接超时（无法建立连接）'), CONNECT_TIMEOUT)
        const stall = setTimeout(() => settle(t, 'failed', '下载超时（长时间无数据）'), STALL_TIMEOUT)
        timers.set(t.id, { connect, stall })
        try {
            if (t.libId) {
                // 会话内续传（暂停后继续）：引擎里那次下载还在。
                lib.resumeDownload(t.libId)
            } else {
                // 全新下载。注意：库要求必须 await download()，否则行为不确定。
                t.libId = await lib.download({
                    window: t.window,
                    url: t.url,
                    saveAsFilename: t.filename,
                    directory: t.directory,
                    overwrite: t.overwrite,
                    callbacks: buildCallbacks(t),
                })
                // 连接建立后才拿到 libId：若期间用户点过暂停（断网连接中），立即补暂停。
                if (pendingPauses.has(t.id)) {
                    pendingPauses.delete(t.id)
                    if (t.libId) lib.pauseDownload(t.libId)
                    t.status = 'paused'
                    t.downloadSpeed = 0
                    clearTimers(t.id) // 连接中暂停也要停表
                    finishTask(t.id)
                    return
                }
            }
        } catch (err) {
            pendingPauses.delete(t.id)
            t.status = 'failed'
            t.error = (err as Error).message
            // 库在派发阶段就抛错（目录不可写 / 文件名非法等），不会走 settle
            log.error(`[download] ${t.filename} 启动下载失败\nurl: ${t.url}\n${formatError(err)}`)
            emitFailed(t)
            finishTask(t.id)
        }
    }

    const add: DownloadManagerApi['add'] = (input, window) => {
        allDoneNotified = false
        const task: InternalTask = {
            ...input,
            id: input.id ?? randomUUID(),
            status: 'waiting',
            createdAt: Date.now(),
            progress: 0,
            downloadedBytes: 0,
            totalBytes: 0,
            downloadSpeed: 0,
            window,
        }
        tasks.set(task.id, task)
        queue.push(task.id)
        pump()
        return task.id
    }

    /**
     * 批量加入：把所有输入一次性建成 waiting 任务入队，再统一 pump() 调度一次。
     * 返回 id 顺序与入参一致。
     * 渲染端保证在调用前所有任务记录已原子落库，故此处只负责调度，不触碰 DB。
     */
    const addBatch: DownloadManagerApi['addBatch'] = (inputs, window) => {
        allDoneNotified = false
        const ids: string[] = []
        for (const input of inputs) {
            const task: InternalTask = {
                ...input,
                id: input.id ?? randomUUID(),
                status: 'waiting',
                createdAt: Date.now(),
                progress: 0,
                downloadedBytes: 0,
                totalBytes: 0,
                downloadSpeed: 0,
                window,
            }
            tasks.set(task.id, task)
            queue.push(task.id)
            ids.push(task.id)
        }
        pump()
        return ids
    }

    const pause = (id: string): boolean => {
        const t = tasks.get(id)
        if (!t) return false
        clearTimers(id)
        if (t.status === 'downloading' && t.libId) {
            // 先翻状态再暂停：确保 lib.pauseDownload 后可能晚到的引擎回调见到 paused，
            // 配合 buildCallbacks 的 `t.status !== 'downloading'` 守卫，不会重新武装停滞计时器。
            t.status = 'paused'
            t.downloadSpeed = 0
            lib.pauseDownload(t.libId)
            // 释放并发槽位：暂停掉一个正在跑的任务后，队列里排队的应该立刻补上。
            // 漏了这句 active 里会永远占着一格，后续排队任务全卡住。
            finishTask(t.id)
            return true
        }
        if (t.status === 'waiting') {
            const i = queue.indexOf(id)
            if (i >= 0) queue.splice(i, 1)
            t.status = 'paused'
            return true
        }
        if (t.status === 'downloading' && !t.libId) {
            // 正在建立连接、尚未拿到 libId（断网连 socket 阶段）：lib.pauseDownload 无 libId 可调用，
            // 先标记待暂停，等 libId 到位（startLib 内）立即补暂停——否则这类任务无法被暂停。
            pendingPauses.add(id)
            return true
        }
        return t.status === 'paused'
    }

    const resume = (id: string): boolean => {
        const t = tasks.get(id)
        if (!t) return false
        if (t.status === 'downloading' || t.status === 'waiting') return true
        if (t.status === 'paused' || t.status === 'failed') {
            // 不直接进入 downloading，先回 waiting 队列，等 pump() 有空位再启动。
            // paused 且已启动过（有 libId）→ 启动时 resumeDownload 续传；failed → 重新下载。
            t.status = 'waiting'
            t.error = undefined
            queue.push(id)
            pump()
            return true
        }
        return false
    }

    /**
     * 删除任务可能留下的残留：目标文件 + 引擎的 `.download` / `.part` 快照。
     * 传了 `saveAsFilename` 时引擎路径恒为 `join(directory, filename)`，不会再改名。
     *
     * ⚠️ best-effort：正在下载 / 刚被引擎取消时 Chromium 可能仍持有句柄 → `unlink` 会 EPERM。
     * 这时不重试也不告警 —— 渲染端启动清理会把「非 completed」记录的残留再扫一遍。
     * @returns 实际删掉的文件数
     */
    const removeArtifacts = (directory: string, filename: string): number => {
        let n = 0
        const base = join(directory, filename)
        for (const p of [`${base}.download`, `${base}.part`, base]) {
            if (!existsSync(p)) continue
            try {
                unlinkSync(p)
                n++
            } catch {
            }
        }
        return n
    }

    const remove = (id: string): boolean => {
        const t = tasks.get(id)
        if (!t) return false
        clearTimers(id)
        if (t.status === 'downloading' && t.libId) lib.cancelDownload(t.libId)
        const i = queue.indexOf(id)
        if (i >= 0) queue.splice(i, 1)
        tasks.delete(id)
        pendingPauses.delete(id)
        finishTask(id)
        removeArtifacts(t.directory, t.filename)
        return true
    }

    const list = (): DownloadTask[] => [...tasks.values()].map(toPublic)

    /** 未完成任务（下载中 / 已暂停 / 排队中） */
    const listUnfinished = (): DownloadTask[] =>
        [...tasks.values()]
            .filter((t) => t.status !== 'completed' && t.status !== 'failed')
            .map(toPublic)

    /**
     * 把给定任务的下载记录标成 `cancelled`
     */
    const markRecordsCancelled = (ids: string[]): number => {
        let n = 0
        for (const id of ids) {
            try {
                if (db.update('download_records', { id }, { status: 'cancelled' })) n++
            } catch (e) {
                log.warn(`[download] 记录 ${id} 标记 cancelled 失败\n${formatError(e)}`)
            }
        }
        return n
    }

    /**
     * 退出前取消所有未完成任务（下载中 / 已暂停 / 排队中），并清掉各自可能留下的残留文件。
     * 引擎取消后 Chromium 通常会删掉未完成的目标文件，但不保证 —— 自己再删一遍兜底。
     */
    const cancelAllPending = () => {
        let n = 0
        for (const t of tasks.values()) {
            if (t.status === 'completed' || t.status === 'failed') continue
            if (t.libId) lib.cancelDownload(t.libId)
            removeArtifacts(t.directory, t.filename)
            n++
        }

    }

    return { add, addBatch, pause, resume, remove, list, listUnfinished, markRecordsCancelled, setEmitter, cancelAllPending }
}


export const downloadManager = createDownloadManager()
