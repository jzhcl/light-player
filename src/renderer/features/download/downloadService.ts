import { LP_EVENT } from '@shared/event'
import { rlog } from '@renderer/lib/log'
import { isOk, ok, fail } from '@shared/result'
import { join, generateId } from '@shared/utils'
import { getCurrentFileNameFormat, renderFileName } from '@renderer/lib/fileNameFormat'
import { QUALITY_BY_BITRATE, QUALITY_ABBR } from '@renderer/lib/constants'
import { formatDate, formatSize } from '@shared/format'
import { invokeResult } from '@renderer/lib/ipc'
import { deleteFile, getFileInfo, isFileExists } from '@renderer/lib/file'
import { eventBus } from '@renderer/lib/eventBus'
import { clearFileMissing } from '@renderer/lib/localFileCheck'
import { useSettingsStore, useDownloadStore } from '@renderer/store'
import { getSongLink } from '@renderer/features/player/songLinkService'
import {
    getDownloadRecordById,
    updateDownloadRecordStatus,
    markDownloadRecordCompleted,
    markDownloadRecordFailed,
    failInterruptedDownloadRecord,
    markDownloadRecordScanned,
    getUncleanedInterruptedRecords,
    getCompletedDownloadFilePaths,
    createDownloadRecord,
    createDownloadRecords,
    getUnfinishedDownloadRecord,
    deleteDownloadRecordBySongAndQuality,
} from '@renderer/lib/db/downloadRecord'
import { getSongById } from '@renderer/lib/db/song'
import { updateSong } from '@renderer/features/song/songWrite'

// 对外保留按 id 查记录的入口
export { getDownloadRecordById }

// ============================================================
// 渲染端下载服务：初始化清理 + 事件驱动记录维护 + IPC 封装
// ============================================================

/**
 * 下载初始化：清理上次没下完的残留。
 *
 * 主进程退出时会主动取消所有未完成任务，所以「启动时 `download_records` 里还是未完成状态」的，
 * 要么是强杀 / 断电留下的（没走 will-quit），要么是上次没来得及收尾的。统一按已中断处理。
 *
 * `scanned` 字段：每条记录只在「本次启动清理」中置 1 一次，
 * 避免每次启动都对每个未成功记录做一遍磁盘检查。正常的下载完成 / 取消 / 失败都不更新该字段。
 */
export async function initDownload(): Promise<void> {
    // 订阅主进程下载事件（开始/完成/失败），维护 download_records 状态与失败残留清理。
    subscribeDownloadEvents()

    // ⚠️ 别在 SQL 里滤掉 `file_path` 为空的记录 —— 那种记录也得走「状态修正」（否则崩溃后
    // 一条没有路径的「排队中」记录会永远显示排队），扫文件时再按 filePath 是否为空跳过即可。
    const rows = await getUncleanedInterruptedRecords()
    if (!isOk(rows)) {
        return
    }
    if (rows.value.length === 0) return

    rlog.info(`[download] 发现 ${rows.value.length} 条未清理的中断下载记录，开始清理残留`)
    // 残留清理涉及磁盘 I/O，异步提交，不阻塞启动。
    void cleanupInterruptedRecords(rows.value)
}

/**
 * 对一批「未成功且未扫过」的下载记录做中断处理：删磁盘残留 + 把「没跑完三态」标 failed，
 * 最后把每条置 scanned=1。
 */
async function cleanupInterruptedRecords(records: LP.DownloadRecord[],): Promise<void> {
    // ⚠️ 路径被任何 completed 记录占用的一律不碰：记录是保留的，旧记录可能指向
    // 「之后重新下好」的同名文件，按旧记录删会把好文件删掉。拿不到就整体跳过。
    const donePaths = await getCompletedDownloadFilePaths()
    if (!isOk(donePaths)) {
        return
    }
    const completedPaths = new Set(donePaths.value)

    for (const record of records) {
        const { filePath } = record
        if (filePath && !completedPaths.has(filePath)) {
            for (const p of [filePath, `${filePath}.download`, `${filePath}.part`]) {
                if (await isFileExists(p)) {
                    await deleteFile(p)
                }
            }
        }
        // 只有「上次没跑完」的三态才改状态；`cancelled` / `failed` 只扫文件、状态保持不动
        if (record.status === 'waiting' || record.status === 'downloading' || record.status === 'paused') {
            await failInterruptedDownloadRecord(record.id, record.status)
        }
        // 扫过即标记，避免下次启动重复扫（唯一置 1 的时机）
        await markDownloadRecordScanned(record.id)
    }
}

// ============================================================
// 残留文件清理（下载失败 / 取消 / 移除 时复用）
// ============================================================

/**
 * 按完整路径清理下载残留：目标文件 + 引擎可能留下的 `.download` / `.part`。
 * best-effort：句柄未释放会 EPERM，失败只告警不重试。返回实际删掉的文件数。
 */
async function cleanupArtifactsByPath(filePath: string): Promise<number> {
    let n = 0
    for (const p of [filePath, `${filePath}.download`, `${filePath}.part`]) {
        if (!(await isFileExists(p))) continue
        // 失败清理：引擎/Chromium 刚取消下载时可能仍持句柄（EPERM），等一会重试，最多 3 次。
        let deleted = false
        for (let attempt = 0; attempt < 3 && !deleted; attempt++) {
            const del = await deleteFile(p)
            if (isOk(del)) {
                deleted = true
                n++
                break
            }
            await new Promise((res) => setTimeout(res, 300))
        }

    }
    return n
}

/** 由下载任务的 directory + filename 推导路径并清理残留。 */
function cleanupArtifactsByTask(task: DownloadTask): Promise<number> {
    return cleanupArtifactsByPath(join(task.directory, task.filename))
}

// ============================================================
// 事件订阅：开始 / 完成 / 失败 → 更新记录 +（失败）清理残留
// ============================================================

/**
 * 订阅主进程推送的下载事件，维护 download_records 状态：
 *  - STARTED   → 记录置 `downloading`
 *  - COMPLETED → 记录置 `completed` + 落 filePath
 *  - FAILED    → 记录置 `failed` + 清理残留
 * 这些 handler 只改 `status`，不碰 `scanned`（scanned 只在 initDownload 置 1）。
 * 每次事件后重新推导 activeCount（download:list），保证导航栏进度条与真相一致。
 *
 * @returns 取消全部订阅的函数
 */

/**
 * 以 download:list 真实在途任务数推导 activeCount
 */
export async function recomputeActiveCount(): Promise<void> {
    const res = await invokeResult<DownloadTask[]>('download:list')
    if (!isOk(res)) return
    const active = res.value.filter((t) => t.status === 'downloading' || t.status === 'waiting').length
    useDownloadStore.getState().setActiveCount(active)
}

function subscribeDownloadEvents(): () => void {
    const offs = [
        window.api.on(LP_EVENT['DOWNLOAD.STARTED'], (...args: unknown[]) => {
            const task = args[0] as DownloadTask
            eventBus.emit(LP_EVENT['DOWNLOAD.STARTED'], task)
            void recomputeActiveCount()
        }),
        window.api.on(LP_EVENT['DOWNLOAD.COMPLETED'], (...args: unknown[]) => {
            const task = args[0] as DownloadTask
            const filePath = join(task.directory, task.filename)
            void (async () => {
                // 以实际文件大小为准更新记录（getSongLink 预估的 size 不可靠）
                const info = await getFileInfo(filePath)
                const size = info && info.type === 'file' ? formatSize(info.size) : undefined
                const r = await markDownloadRecordCompleted(task.id, filePath, size)
                if (!isOk(r)) {
                    rlog.warn(`[download] 完成但落库失败 ${task.filename}：${r.error}`)
                    return
                }
                rlog.info(`[download] 完成 ${task.filename}${size ? `（${size}）` : ''}\ntaskId: ${task.id}`)
                // 已落 completed → 广播到渲染端 eventBus
                eventBus.emit(LP_EVENT['DOWNLOAD.COMPLETED'], task)
                // 回写歌曲 downloadQualities
                const rec = await getDownloadRecordById(task.id)
                if (!isOk(rec) || !rec.value) return
                const { songId, quality } = rec.value
                if (!songId || !quality) return
                const songR = await getSongById(songId)
                if (!isOk(songR) || !songR.value) return
                const cur = songR.value.downloadQualities ?? []
                const next = [...cur.filter((q) => q.type !== quality), { type: quality, path: filePath, size }]
                await updateSong(songId, { downloadQualities: next })
                // 重新下载完成 → 清掉「本地文件缺失」标记（自愈缺失状态）
                clearFileMissing(filePath)
                void recomputeActiveCount()
            })()
        }),
        window.api.on(LP_EVENT['DOWNLOAD.FAILED'], (...args: unknown[]) => {
            const task = args[0] as DownloadTask
            void (async () => {
                // 落 failed + 失败原因（task.error 来自主进程 onError / onDownloadInterrupted）
                rlog.warn(`[download] 失败 ${task.filename}：${task.error ?? '未知原因'}\ntaskId: ${task.id}`)
                await markDownloadRecordFailed(task.id, task.error)
                // 失败即清残留：主进程在失败时并不删文件（句柄可能未释放），留给这里兜底
                void cleanupArtifactsByTask(task)
                // 桥接到渲染端 eventBus（在 DB 状态落定之后）
                eventBus.emit(LP_EVENT['DOWNLOAD.FAILED'], task)
                void recomputeActiveCount()
            })()
        }),

    ]
    return () => offs.forEach((off) => off())
}

// ============================================================
// 下载歌曲：解析链接 → 落记录 → 发起任务
// ============================================================

/** 从 URL 或本地路径推断音频扩展名（取最后一个 `.ext`，忽略 ?#），失败回退 mp3。 */
function audioExtFromUrl(url: string): string {
    const m = url.match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/)
    return m ? m[1].toLowerCase() : 'mp3'
}

/**
 * 由歌曲、链接与音质推导下载文件名。
 * 格式由设置项 `download.fileNameFormat` 决定，
 * 其中音质后缀随「实际下载音质」变化（标准音质为空；HQ→_H、SQ→_S、Hi-Res→_R、Master→_M），
 * 因为会员降级后实际音质可能低于偏好。扩展名从 URL/路径取，取不到回退 mp3。
 * 非法字符替换由 `renderFileName` 内部完成。
 */
function buildDownloadFilename(song: LP.Song, url: string, quality: Quality): string {
    return renderFileName(getCurrentFileNameFormat(), {
        name: song.name || 'song',
        singer: song.singer || '',
        album: song.album || '',
        quality: quality === 'Standard' ? '' : QUALITY_ABBR[quality],
        ext: audioExtFromUrl(url),
    })
}

/**
 * 构造一条「已触发但无法继续」的失败记录：断网取不到链接 / 无可用音质等。
 * 不携带真实 URL（拿不到），文件名按模板尽力构造（无 URL 时扩展名回退 mp3）；
 * status 直接置 failed 并写入错误原因，使其在【下载记录】里可见。
 */
function makeFailedRecord(song: LP.Song, quality: Quality | undefined, error: string): LP.DownloadRecord {
    const filename = buildDownloadFilename(song, '', quality ?? 'Standard')
    return {
        id: generateId('download'),
        songId: song.id,
        url: undefined,
        fileName: filename,
        quality,
        size: undefined,
        status: 'failed',
        error,
        progress: 0,
        scanned: 0,
        createdAt: formatDate(),
        updatedAt: formatDate(),
    }
}

/**
 * 解析下载采用的音质，走「优先下载音质」偏好。
 * 优先级：调用方指定（菜单选音质）> 下载全局偏好。
 * 下载偏好关闭时固定 Standard（无则取最低）。
 */
function resolveDownloadQuality(song: LP.Song, requested?: Quality): Result<Quality> {
    const supported = (song.supportQualities ?? []).map((q) => q.type)
    if (!supported.length) return fail(`歌曲【${song.name}】无可用音质`)

    if (requested) {
        if (!supported.includes(requested)) return fail(`歌曲【${song.name}】不支持 '${requested}' 音质`)
        return ok(requested)
    }

    const preferHigher = useSettingsStore.getState().settings['download.preferHigherQuality']
    if (preferHigher) {
        for (const q of QUALITY_BY_BITRATE) {
            if (supported.includes(q)) return ok(q)
        }
    }
    if (supported.includes('Standard')) return ok('Standard')
    return ok(supported[0])
}

/** 单首下载的明确结果，区分「新入队 / 已下载 / 进行中 / 失败」，供 `downloadSongs` 精确提示。 */
type DownloadOutcome =
    | { kind: 'queued'; id: string }
    | { kind: 'downloaded'; path: string }
    | { kind: 'in-progress'; id: string }
    | { kind: 'failed'; error: string }

/** 提交主进程调度所需的任务载荷（与 `download:add` / `download:addBatch` 入参一致）。 */
interface DownloadTaskPayload {
    id: string
    url: string
    filename: string
    directory: string
}

/**
 * 「准备一首歌的下载任务」：去重 + 续传防护 + 解析链接 + 构造记录，产出可提交主进程的任务载荷与待入库记录。
 * 不发起主进程调度、也不入库（交给 `downloadSong` 单发或 `downloadSongs` 批量提交/批量入库）。
 *  - 已下载实际音质且本地文件仍在 → skip(downloaded)；
 *  - 同歌曲同实际音质存在未完成任务 → skip(in-progress)；
 *  - 清理旧记录后解析链接成功 → task(含 payload + 待入库 record)；
 *  - 任一环节失败 → fail(中文原因)。
 *
 * ⚠️ 音质以 `getSongLink` 实际返回的为准：会员降级会让实际音质低于偏好/指定音质，
 * 记录、文件名、去重都按实际音质，避免错位。
 */
type PrepareResult =
    | { kind: 'skip'; outcome: DownloadOutcome }
    | { kind: 'fail'; error: string }
    | { kind: 'task'; payload: DownloadTaskPayload; record: LP.DownloadRecord }
    // 已触发下载但因「无法继续」而直接落一条 failed 记录（断网取不到链接 / 无可用音质等）；
    // 不提交主进程调度，仅入库让它在【下载记录】里可见。
    | { kind: 'failed-record'; record: LP.DownloadRecord }

async function prepareOneDownload(song: LP.Song, quality?: Quality): Promise<PrepareResult> {
    // 下载音质走「优先下载音质」偏好，得到本次「目标音质」；实际音质以 getSongLink 返回为准。
    const qR = resolveDownloadQuality(song, quality)
    if (!isOk(qR)) return { kind: 'failed-record', record: makeFailedRecord(song, undefined, qR.error) }
    const targetQuality = qR.value

    // 先解析链接拿到「实际可下载音质」（会员降级后可能低于目标音质），后续去重/记录/文件名一律用它。
    // 断网 / 链接失效时取不到 → 直接落一条 failed 记录，不抛错中断。
    const linkR = await getSongLink(song, targetQuality)
    if (!isOk(linkR)) return { kind: 'failed-record', record: makeFailedRecord(song, targetQuality, linkR.error) }
    const actualQuality = linkR.value.quality

    // 仅用户显式指定音质且实际不符时报错（自动/优先较高路径放行，按实际音质落库）。
    if (quality && actualQuality !== quality) {
        return { kind: 'fail', error: `歌曲【${song.name}】实际可下载音质为 ${actualQuality}，与指定的 ${quality} 不符` }
    }

    // 1) 已下载该实际音质且本地文件仍在 → 返回既有路径，不重复下载
    const downloaded = song.downloadQualities?.find((q) => q.type === actualQuality)
    if (downloaded?.path && (await isFileExists(downloaded.path))) {
        return { kind: 'skip', outcome: { kind: 'downloaded', path: downloaded.path } }
    }

    // 2) 同歌曲同实际音质存在未完成任务（等待/下载中/暂停）→ 不重复发起
    const unfinished = await getUnfinishedDownloadRecord(song.id, actualQuality)
    if (!isOk(unfinished)) return { kind: 'fail', error: unfinished.error }
    if (unfinished.value) return { kind: 'skip', outcome: { kind: 'in-progress', id: unfinished.value.id } }

    // 3) 清理该歌曲该实际音质的旧记录（失败的、已完成但本地文件缺失需重下的、已取消的），
    //    为新下载让出干净状态。此处已确认无未完成任务，删除仅针对终态记录，安全。
    await deleteDownloadRecordBySongAndQuality(song.id, actualQuality)

    const dir = useSettingsStore.getState().settings['path.downloadDir']
    if (!dir) return { kind: 'fail', error: '下载目录未就绪，请稍候重试' }

    const { url } = linkR.value
    const filename = buildDownloadFilename(song, url, actualQuality)
    const taskId = generateId('download')

    const record: LP.DownloadRecord = {
        id: taskId,
        songId: song.id,
        url,
        fileName: filename,
        quality: actualQuality,
        size: song.supportQualities?.find((q) => q.type === actualQuality)?.size,
        status: 'waiting',
        scanned: 0,
        createdAt: formatDate(),
        updatedAt: formatDate(),
    }

    return { kind: 'task', payload: { id: taskId, url, filename, directory: dir }, record }
}

/**
 * 下载一首歌：准备任务 → 落一条记录 → 触发事件 → 单发 `download:add` 入主进程队列。
 * 批量场景请走 `downloadSongs`。
 *
 * @returns 明确结果：新入队 / 已下载 / 进行中 / 失败（失败带中文原因）。
 */
export async function downloadSong(song: LP.Song, quality?: Quality): Promise<DownloadOutcome> {
    const p = await prepareOneDownload(song, quality)
    if (p.kind === 'task') {
        // 先落记录（status=waiting），再触发事件让页面一次性拉取最新数据，最后入主进程队列。
        const recR = await createDownloadRecord(p.record)
        if (!isOk(recR)) return { kind: 'failed', error: recR.error }
        eventBus.emit(LP_EVENT['DOWNLOAD.TASK_ADDED'])
        const addR = await invokeResult<string>('download:add', p.payload)
        if (!isOk(addR)) {
            // 发起失败：把刚落的记录标 failed，避免留一条永远 waiting 的脏记录
            await updateDownloadRecordStatus(p.payload.id, 'failed')
            rlog.warn(`[download] 发起失败 ${song.name}-${song.singer}：${addR.error}`)
            return { kind: 'failed', error: addR.error }
        }
        // 音质是「实际要下的档」，就近回退后的结果 —— 拿不到用户偏好以外的信息就记入参
        rlog.info(
            `[download] 入队 ${song.name}-${song.singer}(${song.album ?? '未知专辑'}) 音质 ${quality ?? '跟随首选'}\nsongId: ${song.id}\ntaskId: ${p.payload.id}`,
        )
        return { kind: 'queued', id: p.payload.id }
    }
    if (p.kind === 'failed-record') {
        // 已触发但无法继续（断网 / 无可用音质）：落一条 failed 记录，使其在【下载记录】可见。
        const recR = await createDownloadRecord(p.record)
        if (isOk(recR)) eventBus.emit(LP_EVENT['DOWNLOAD.TASK_ADDED'])
        return { kind: 'failed', error: p.record.error ?? '下载失败' }
    }
    if (p.kind === 'skip') return p.outcome
    return { kind: 'failed', error: p.error }
}

/**
 * 批量下载（菜单「下载」对整段选区生效）。逐首解析链接并排队，按结果精确提示。
 * 单首会直接透出具体结果（含失败原因）；多首汇总 入队 / 已存在 / 失败 计数。
 * 单首失败不影响其余；失败时记录已标 failed。
 */
export async function downloadSongs(songs: LP.Song[], quality?: Quality): Promise<void> {
    if (songs.length === 0) return

    // 单首：直接把结果（含具体失败原因）透传给用户
    if (songs.length === 1) {
        const s = songs[0]
        const r = await downloadSong(s, quality)
        switch (r.kind) {
            case 'queued':
                break
            case 'downloaded':
                break
            case 'in-progress':
                break
            case 'failed':
                break
        }
        return
    }

    // 多首：先批量准备（解析链接 + 构造记录），收集记录后一次性批量入库，再触发一次事件让页面拉取最新数据，
    // 最后一次性 submit `download:addBatch`。
    const tasks: DownloadTaskPayload[] = []
    const records: LP.DownloadRecord[] = [] // 待调度（waiting）
    const failedRecords: LP.DownloadRecord[] = [] // 已触发但失败（离线 / 无可用音质）
    let skipped = 0
    let failed = 0
    const errors: string[] = []
    for (const s of songs) {
        const p = await prepareOneDownload(s, quality)
        if (p.kind === 'task') {
            tasks.push(p.payload)
            records.push(p.record)
        } else if (p.kind === 'skip') skipped++ // downloaded / in-progress
        else if (p.kind === 'failed-record') {
            failedRecords.push(p.record)
            failed++
            errors.push(p.record.error ?? '下载失败')
        } else {
            failed++
            errors.push(p.error)
        }
    }

    const allRecords = [...records, ...failedRecords]
    if (allRecords.length > 0) {
        // 批量入库
        const insR = await createDownloadRecords(allRecords)
        if (!isOk(insR)) {
            failed += allRecords.length
            errors.push(`批量写入下载记录失败：${insR.error}`)
        } else {
            // 记录已落库 → 触发事件，页面据此一次性拉取最新数据。
            eventBus.emit(LP_EVENT['DOWNLOAD.TASK_ADDED'])
            if (tasks.length > 0) {
                const idsR = await invokeResult<string[]>('download:addBatch', tasks)
                if (!isOk(idsR)) {
                    // 批量提交失败：把刚落的 waiting 记录标 failed，避免留一堆永远 waiting 的脏记录
                    for (const t of tasks) await updateDownloadRecordStatus(t.id, 'failed')
                    failed += tasks.length
                    errors.push(`批量提交失败：${idsR.error}`)
                }
            }
        }
    }

    // 批量下载的最终结果。没有这条的话：多选下载后界面毫无变化，日志里也查不到发生过什么 ——
    // 这正是 `skipped` / `failed` / `errors` 唯一该被读的地方
    rlog.info(
        `[download] 批量下载 ${songs.length} 首：提交 ${tasks.length} 首，跳过 ${skipped} 首，失败 ${failed} 首` +
            (errors.length > 0 ? `\n失败原因: ${errors.join('; ')}` : ''),
    )
}

