import { useCallback, useEffect, useMemo, useState } from 'react'
import { isOk } from '@shared/result'
import { formatSize, qualityLabel } from '@shared/format'
import { invokeResult } from '@renderer/lib/ipc'
import { Icon } from '@renderer/components/Icon'
import { Cover } from '@renderer/components/ui/Cover'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { Modal } from '@renderer/components/ui/Modal'
import { useEvent } from '@renderer/hooks/useEvent'
import { LP_EVENT } from '@shared/event'
import {
    getAllDownloadRecords,
    deleteDownloadRecordById,
    updateDownloadRecordStatus,
    markDownloadRecordPaused,
} from '@renderer/lib/db/downloadRecord'
import { getSongsByIds, getSongById } from '@renderer/lib/db/song'
import { updateSong } from '@renderer/features/song/songWrite'
import { recomputeActiveCount, downloadSong } from '@renderer/features/download/downloadService'
import { idList, rlog } from '@renderer/lib/log'
import { message } from '@renderer/lib/message'

interface RecordRow {
    record: LP.DownloadRecord
    song?: LP.Song
    task?: DownloadTask
}


interface DownloadRecordsTabProps {
    /**
     * 记录集合增删后通知父页（父页据此重查条数）。
     */
    onRecordsChanged?: () => void
}

/** 记录集合的内容签名：只含影响渲染的字段 —— 行没有 memo，引用一变就是整表重渲 */
function recordsSignature(recs: readonly LP.DownloadRecord[]): string {
    let s = ''
    for (const r of recs) {
        s += `${r.id}\u0001${r.status}\u0001${r.progress ?? ''}\u0001${r.error ?? ''}\u0001${r.size ?? ''}\u0001${r.fileName ?? ''}\n`
    }
    return s
}

/** 任务集合的内容签名（progress / 速度会持续变化，只有真变才需要重渲） */
function tasksSignature(tasks: readonly DownloadTask[]): string {
    let s = ''
    for (const t of tasks) {
        s += `${t.id}\u0001${t.status}\u0001${t.progress ?? ''}\u0001${t.downloadSpeed ?? ''}\u0001${t.error ?? ''}\n`
    }
    return s
}

export function DownloadRecordsTab({ onRecordsChanged }: DownloadRecordsTabProps) {
    const [records, setRecords] = useState<LP.DownloadRecord[]>([])
    const [songMap, setSongMap] = useState<Map<string, LP.Song>>(new Map())
    const [tasks, setTasks] = useState<DownloadTask[]>([])
    const [loading, setLoading] = useState(true)
    const [clearOpen, setClearOpen] = useState(false)
    /** 批量动作进行中 */
    const [busyAction, setBusyAction] = useState<'start' | 'pause' | 'clear' | null>(null)

    const reload = useCallback(async () => {
        setLoading(true)
        const res = await getAllDownloadRecords()
        if (!isOk(res)) {
            setLoading(false)
            return
        }
        const recs = res.value
        const songIds = Array.from(new Set(recs.map((r) => r.songId).filter((x): x is string => !!x)))
        let map = new Map<string, LP.Song>()
        if (songIds.length > 0) {
            const sr = await getSongsByIds(songIds)
            if (isOk(sr)) map = new Map(sr.value.map((s) => [s.id, s]))
        }
        setRecords(recs)
        setSongMap(map)
        setLoading(false)
    }, [])

    // 重新拉取 download_records（DB）。轮询每 500ms 调一次 ⇒ 内容没变就保持原引用。
    const reloadRecords = useCallback(async () => {
        const res = await getAllDownloadRecords()
        if (!isOk(res)) return
        setRecords((prev) => (recordsSignature(prev) === recordsSignature(res.value) ? prev : res.value))
    }, [])

    useEffect(() => {
        void reload()
    }, [reload])

    // 轮询实时进度/速度：主进程只经 eventBus 广播「状态变更」事件（STARTED/COMPLETED/FAILED），
    // 不推逐帧进度，因此进度条与下载速度需主动轮询 download:list 拿主进程内存态（每 0.5s）。
    // 每轮同时 reloadRecords 重新对齐 download_records：DB 仅作兜底（如主进程已移除的任务、
    // 纯离线失败记录无 row.task 的情况），确保记录列表与真实态一致。
    // 门控：主进程内存有 waiting/downloading 任务即轮询；records（DB）作启动期种子（首帧 tasks 可能为空），避免空窗死锁。
    const hasActive = tasks.some((t) => t.status === 'waiting' || t.status === 'downloading') || records.some((r) => r.status === 'waiting' || r.status === 'downloading')
    useEffect(() => {
        if (!hasActive) return
        let stopped = false
        const tick = async () => {
            if (stopped) return
            const res = await invokeResult<DownloadTask[]>('download:list')
            if (isOk(res)) {
                setTasks((prev) => (tasksSignature(prev) === tasksSignature(res.value) ? prev : res.value))
            }
            await reloadRecords()
        }
        void tick()
        const timer = setInterval(tick, 500)
        return () => {
            stopped = true
            clearInterval(timer)
        }
    }, [hasActive, reloadRecords])

    // 事件现经 downloadService 桥接到 eventBus（主进程 IPC → eventBus），useEvent 可正常收到。
    // 完成/失败只改状态，reloadRecords 足够（songMap 由挂载时 reload 拉全）。
    useEvent(LP_EVENT['DOWNLOAD.STARTED'], () => void reloadRecords())
    useEvent(LP_EVENT['DOWNLOAD.COMPLETED'], () => void reloadRecords())
    useEvent(LP_EVENT['DOWNLOAD.FAILED'], () => void reloadRecords())
    useEvent(LP_EVENT['DOWNLOAD.TASK_ADDED'], () => void reloadRecords())

    // 任务按 id 建索引：原先每条记录 `tasks.find(...)`，记录 × 任务是 O(N×M)
    const taskById = useMemo(() => new Map(tasks.map((t) => [t.id, t] as const)), [tasks])
    const rows = useMemo<RecordRow[]>(
        () =>
            records.map((r) => ({
                record: r,
                song: r.songId ? songMap.get(r.songId) : undefined,
                task: taskById.get(r.id),
            })),
        [records, songMap, taskById],
    )

    // 有效状态：优先主进程内存态（row.task，来自 download:list，实时、无 DB 落库时序竞态）；
    // DB 的 record.status 仅兜底（如任务已从主进程移除、离线失败记录等无 row.task 的情况）。
    const rowStatus = useCallback((row: RecordRow): DownloadStatus => row.task?.status ?? row.record.status, [])

    const statusText = useCallback((row: RecordRow): string => {
        const st = rowStatus(row)
        switch (st) {
            case 'waiting':
                return '等待中'
            case 'downloading':
                return row.task && typeof row.task.progress === 'number'
                    ? `${Math.round(row.task.progress * 100)}%`
                    : '下载中'
            case 'paused':
                return '已暂停'
            case 'failed':
                return '失败'
            case 'completed':
                return '已完成'
            default:
                return st
        }
    }, [rowStatus])

    const statusClass = useCallback((s: DownloadStatus): string => `dl-status--${s}`, [])

    // 进度优先取主进程内存态（实时）；无 row.task 时回退 DB 落库进度（暂停后已落 progress）。
    const rowProgress = useCallback((row: RecordRow): number => {
        if (row.task && typeof row.task.progress === 'number') return row.task.progress
        if (typeof row.record.progress === 'number') return row.record.progress
        return 0
    }, [])

    const pause = useCallback(
        async (row: RecordRow) => {
            const r = await invokeResult<boolean>('download:pause', row.record.id)
            if (isOk(r) && r.value) {
                // 暂停后主动拉取主进程最新任务态（实时 progress），避免只用 0.5s 轮询的旧值（可能还是 0）。
                const listR = await invokeResult<DownloadTask[]>('download:list')
                const live = listR && isOk(listR) ? listR.value.find((t) => t.id === row.record.id) : undefined
                // 暂停时置 paused + 落已下载进度，使【下载记录】暂停后仍能看到进度（实时 task 不再轮询）
                await markDownloadRecordPaused(row.record.id, live?.progress ?? row.task?.progress ?? 0)
            }
            await reload()
            // 暂停改变真实在途数：重算导航栏进度条
            void recomputeActiveCount()
        },
        [reload],
    )

    const resume = useCallback(
        async (row: RecordRow) => {
            // 离线 / 取不到链接导致的「失败记录」：主进程从未建立内存任务（download:list 查不到 → row.task 为空），
            // 调 download:resume 只会返回 false 无效果。重试必须重新发起完整下载流程（解析链接 → 落新记录 → 调度）。
            if (row.record.status === 'failed' && !row.task) {
                if (row.song) {
                    // 先删掉这条旧失败记录，再 downloadSong 重新发起；
                    // ⚠️ 不带 quality：原记录 quality 是自动选取的，重试时重新解析音质，
                    // 避免「显式指定音质 ≠ 实际可下载音质（会员降级）」误判 fail 导致只删不建。
                    rlog.info(
                        `[download] 重试下载 ${row.song.name}\nsongId: ${row.song.id}\n旧记录 recordId: ${row.record.id}`
                    )
                    await deleteDownloadRecordById(row.record.id)
                    await downloadSong(row.song)
                }
                await reload()
                void recomputeActiveCount()
                return
            }
            // 先落 waiting（在 IPC 之前）：主进程 resume 后若立即有空位会发 STARTED → downloading，
            // 写在 IPC 之前可保证 STARTED 的 downloading 覆盖本处 waiting；若写在 IPC 之后，
            // STARTED(downloading) 会被本处 waiting 覆盖，记录永久卡在「等待中」（即便已在下载）。
            await updateDownloadRecordStatus(row.record.id, 'waiting')
            const resumed = await invokeResult<boolean>('download:resume', row.record.id)
            // 这条链路不走 downloadSong，所以那边「入队」的日志覆盖不到它
            rlog.info(`[download] 恢复任务 ${row.record.fileName}\nrecordId: ${row.record.id}`)
            if (!isOk(resumed) || !resumed.value) {
                rlog.warn(
                    `[download] 恢复未生效（主进程无此任务）\nrecordId: ${row.record.id}\n${isOk(resumed) ? '返回 false' : resumed.error}`
                )
            }
            await reload()
            void recomputeActiveCount()
        },
        [reload],
    )

    const removeRow = useCallback(
        async (row: RecordRow) => {
            await invokeResult<boolean>('download:remove', row.record.id).catch(() => {})
            rlog.info(`[download] 移除记录 ${row.record.fileName}\nrecordId: ${row.record.id}`)
            await deleteDownloadRecordById(row.record.id)
            // 一致性：清掉该音质，使歌曲从「下载歌曲」Tab 移出
            if (row.record.songId && row.record.quality) {
                const sr = await getSongById(row.record.songId)
                if (isOk(sr) && sr.value) {
                    const cur = (sr.value.downloadQualities ?? []).filter((q) => q.type !== row.record.quality)
                    await updateSong(row.record.songId, { downloadQualities: cur })
                }
            }
            await reload()
            // 记录集合变了 → 让父页重查条数
            onRecordsChanged?.()
            void recomputeActiveCount()
        },
        [reload, onRecordsChanged],
    )

    const startAll = useCallback(async () => {
        if (busyAction) return
        setBusyAction('start')
        try {
            for (const row of rows) {
                if (row.record.status !== 'paused') continue
                // 先落 waiting（IPC 之前），理由同 resume：避免被 STARTED(downloading) 覆盖卡在「等待中」。
                await updateDownloadRecordStatus(row.record.id, 'waiting')
                await invokeResult<boolean>('download:resume', row.record.id)
            }
            await reload()
            void recomputeActiveCount()
        } finally {
            setBusyAction(null)
        }
    }, [rows, reload, busyAction])

    const pauseAll = useCallback(async () => {
        if (busyAction) return
        setBusyAction('pause')
        try {
            const targets = rows.filter((row) => row.record.status === 'waiting' || row.record.status === 'downloading')
            for (const row of targets) {
                await invokeResult<boolean>('download:pause', row.record.id)
            }
            // 全部暂停后统一拉取主进程最新任务态（实时 progress），逐个落已下载进度（避免只用 0.5s 轮询旧值）
            const listR = await invokeResult<DownloadTask[]>('download:list')
            const liveMap = listR && isOk(listR) ? new Map(listR.value.map((t) => [t.id, t])) : new Map<string, DownloadTask>()
            for (const row of targets) {
                const live = liveMap.get(row.record.id)
                await markDownloadRecordPaused(row.record.id, live?.progress ?? row.task?.progress ?? 0)
            }
            await reload()
            void recomputeActiveCount()
        } finally {
            setBusyAction(null)
        }
    }, [rows, reload, busyAction])

    const clearAll = useCallback(async () => {
        if (busyAction) return
        setBusyAction('clear')
        try {
            for (const row of rows) {
                await invokeResult<boolean>('download:remove', row.record.id).catch(() => {})
                await deleteDownloadRecordById(row.record.id)
            }
            await reload()
            onRecordsChanged?.()
            void recomputeActiveCount()
            rlog.info(
                `[local] 清空下载记录：${rows.length} 条\nrecordIds: ${idList(rows.map((r) => r.record.id))}`,
            )
            message.success(`已清除 ${rows.length} 条下载记录`)
        } finally {
            setBusyAction(null)
            setClearOpen(false)
        }
    }, [rows, reload, busyAction, onRecordsChanged])

    return (
        <div className="dl-tab">
            {rows.length > 0 ? (
                <div className="dl-toolbar">
                    <button
                        className="dl-tool-btn"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void startAll()}
                    >
                        <Icon name="play" size={16} />
                        <span>{busyAction === 'start' ? '处理中…' : '全部开始'}</span>
                    </button>
                    <button
                        className="dl-tool-btn"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void pauseAll()}
                    >
                        <Icon name="pause-fill" size={16} />
                        <span>{busyAction === 'pause' ? '处理中…' : '全部暂停'}</span>
                    </button>
                    <button
                        className="dl-tool-btn dl-tool-btn--danger"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => setClearOpen(true)}
                    >
                        <Icon name="trash" size={16} />
                        <span>清除所有下载记录</span>
                    </button>
                </div>
            ) : null}

            {rows.length > 0 ? (
                <ScrollArea className="dl-scroll" scrollClassName="dl-scroll-view" thumbClassName="dl-scroll-thumb" autoHide deps={[rows]}>
                    <div className="dl-list">
                        {rows.map((row) => {
                            const r = row.record
                            const st = rowStatus(row)
                            const qualityText = r.quality ? qualityLabel(r.quality) : ''
                            const isActive = st === 'downloading' || st === 'waiting'
                            return (
                                <div className="dl-item" key={r.id}>
                                    <div className="dl-item__pic">
                                        <Cover pic={row.song?.pic} className="dl-item__cover" />
                                    </div>
                                    <div className="dl-item__info">
                                        <div className="dl-item__title">
                                            <span className="dl-item__name ellipsis">
                                                {row.song?.name || r.fileName || r.songId || '未知歌曲'}
                                            </span>
                                            {qualityText ? <span className="dl-item__quality">{qualityText}</span> : null}
                                        </div>
                                        <div className="dl-item__meta">
                                            {row.song?.singer ? <span className="dl-item__singer ellipsis">{row.song.singer}</span> : null}
                                            {r.size ? <span className="dl-item__size">{formatSize(r.size)}</span> : null}
                                        </div>
                                        {(() => {
                                            const p = rowProgress(row)
                                            // 仅在 0 < 进度 < 1 时显示进度条：等待/暂停/下载中只要有部分进度都显示；
                                            // 0%（尚未开始）与 100%（已完成）不显示，避免「满格」误显；失败记录不显示（已是终态，只显示失败原因）。
                                            return p > 0 && p < 1 && st !== 'failed' ? (
                                                <div className="dl-item__progress">
                                                    <div className="dl-item__progress-bar">
                                                        <div className="dl-item__progress-fill" style={{ width: `${Math.round(p * 100)}%` }} />
                                                    </div>
                                                    {st === 'downloading' && row.task?.downloadSpeed ? (
                                                        <span className="dl-item__speed">{formatSize(row.task.downloadSpeed)}/s</span>
                                                    ) : null}
                                                </div>
                                            ) : null
                                        })()}
                                        {st === 'failed' && (r.error || row.task?.error) ? (
                                            <div className="dl-item__error" title={r.error || row.task?.error}>
                                                {r.error || row.task?.error}
                                            </div>
                                        ) : null}
                                    </div>
                                    <div className="dl-item__status">
                                        <span
                                            className={`dl-status ${statusClass(st)}`}
                                            title={r.error || row.task?.error ? `失败原因：${r.error || row.task?.error}` : undefined}
                                        >
                                            {statusText(row)}
                                        </span>
                                    </div>
                                    <div className="dl-item__actions">
                                        {isActive ? (
                                            <button
                                                className="dl-item__action"
                                                type="button"
                                                title="暂停"
                                                disabled={busyAction !== null}
                                                onClick={() => void pause(row)}
                                            >
                                                <Icon name="pause-fill" size={14} />
                                            </button>
                                        ) : null}
                                        {st === 'paused' ? (
                                            <button
                                                className="dl-item__action"
                                                type="button"
                                                title="继续"
                                                disabled={busyAction !== null}
                                                onClick={() => void resume(row)}
                                            >
                                                <Icon name="play" size={14} />
                                            </button>
                                        ) : null}
                                        {st === 'failed' ? (
                                            <button
                                                className="dl-item__action"
                                                type="button"
                                                title="重试"
                                                disabled={busyAction !== null}
                                                onClick={() => void resume(row)}
                                            >
                                                <Icon name="refresh" size={14} />
                                            </button>
                                        ) : null}
                                        <button
                                            className="dl-item__action dl-item__action--danger"
                                            type="button"
                                            title="删除"
                                            disabled={busyAction !== null}
                                            onClick={() => void removeRow(row)}
                                        >
                                            <Icon name="x" size={14} />
                                        </button>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                </ScrollArea>
            ) : (
                <div className="content-empty center">
                    <Icon name="download" size={44} className="content-empty-icon" />
                    <p className="content-empty-text">{loading ? '加载中…' : '暂无下载记录'}</p>
                    {!loading ? <p className="content-empty-hint">在歌曲上右键选择“下载”开始</p> : null}
                </div>
            )}

            <Modal
                open={clearOpen}
                onOpenChange={(o) => {
                    if (!o) setClearOpen(false)
                }}
                title="清除下载记录"
                className="dl-clear-modal"
                contentStyle={{ width: 420 }}
            >
                <p className="dl-clear-text">
                    确定要清除全部 {rows.length} 条下载记录吗？此操作不可恢复，且会取消进行中的下载任务。
                </p>
                <div className="dl-clear-footer">
                    <button
                        className="dl-clear-cancel"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => setClearOpen(false)}
                    >
                        取消
                    </button>
                    <button
                        className="dl-clear-danger"
                        type="button"
                        disabled={busyAction !== null}
                        onClick={() => void clearAll()}
                    >
                        {busyAction === 'clear' ? '清除中…' : '清除'}
                    </button>
                </div>
            </Modal>
        </div>
    )
}
