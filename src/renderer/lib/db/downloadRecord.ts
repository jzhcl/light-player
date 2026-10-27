import { ok, isOk } from '@shared/result'
import { dbCreate, dbCreateMany, dbDelete, dbFind, dbQuery, dbUpdate } from './base'

/** 按歌曲 ID 查询任意一条下载记录 */
export async function getDownloadRecordBySongId(songId: string): Promise<Result<LP.DownloadRecord | null>> {
    return dbFind<LP.DownloadRecord>('download_records', { songId })
}

/**
 * 查询某歌曲是否存在“未完成 / 进行中”的下载记录
 */
export async function getUnfinishedDownloadRecordBySongId(songId: string): Promise<Result<LP.DownloadRecord | null>> {
    const res = await dbQuery<LP.DownloadRecord>(
        `SELECT *
         FROM download_records
         WHERE song_id = ?
           AND status IN ('waiting', 'downloading', 'paused')
         LIMIT 1`,
        [songId],
    )
    if (!isOk(res)) return res
    return ok(res.value.length > 0 ? res.value[0] : null)
}

/**
 * 查询某歌曲某音质是否存在“未完成 / 进行中”的下载记录（等待/下载中/暂停）。
 */
export async function getUnfinishedDownloadRecord(
    songId: string,
    quality: Quality,
): Promise<Result<LP.DownloadRecord | null>> {
    const res = await dbQuery<LP.DownloadRecord>(
        `SELECT *
         FROM download_records
         WHERE song_id = ?
           AND quality = ?
           AND status IN ('waiting', 'downloading', 'paused')
         LIMIT 1`,
        [songId, quality],
    )
    if (!isOk(res)) return res
    return ok(res.value.length > 0 ? res.value[0] : null)
}

/** 删除某歌曲某音质的全部下载记录（重下前清掉失败/已完成/已取消的旧记录），返回删除行数。 */
export async function deleteDownloadRecordBySongAndQuality(
    songId: string,
    quality: Quality,
): Promise<Result<number>> {
    return dbDelete('download_records', { songId, quality })
}

/** 删除某歌曲的全部下载记录，返回删除行数 */
export async function deleteDownloadRecordsBySongId(songId: string): Promise<Result<number>> {
    return dbDelete('download_records', { songId })
}

/** 按 id 查单条下载记录。 */
export async function getDownloadRecordById(id: string): Promise<Result<LP.DownloadRecord | null>> {
    return dbFind<LP.DownloadRecord>('download_records', { id })
}

/** 获取全部下载记录 */
export async function getAllDownloadRecords(): Promise<Result<LP.DownloadRecord[]>> {
    return dbQuery<LP.DownloadRecord>('SELECT * FROM download_records ORDER BY created_at DESC')
}

/** 新建一条下载记录（status 由调用方指定，通常为 waiting）。 */
export async function createDownloadRecord(record: LP.DownloadRecord): Promise<Result<boolean>> {
    return dbCreate('download_records', record as unknown as Record<string, unknown>)
}

/** 批量新建下载记录（单事务），返回插入行数。 */
export async function createDownloadRecords(records: LP.DownloadRecord[]): Promise<Result<number>> {
    return dbCreateMany('download_records', records as unknown as Record<string, unknown>[])
}

/** 仅改状态 */
export async function updateDownloadRecordStatus(id: string, status: DownloadStatus): Promise<Result<boolean>> {
    return dbUpdate('download_records', { id }, { status })
}

/** 暂停时置 paused + 落已下载进度（0~1） */
export async function markDownloadRecordPaused(id: string, progress: number): Promise<Result<boolean>> {
    return dbUpdate('download_records', { id }, { status: 'paused', progress })
}

/** 失败：置 failed + 落错误信息 */
export async function markDownloadRecordFailed(id: string, error?: string): Promise<Result<boolean>> {
    const patch: Record<string, unknown> = { status: 'failed' }
    if (error !== undefined) patch.error = error
    return dbUpdate('download_records', { id }, patch)
}

/** 完成：置 completed + 落 filePath；可附带实际文件大小（已格式化的字符串）。 */
export async function markDownloadRecordCompleted(
    id: string,
    filePath: string,
    size?: string,
): Promise<Result<boolean>> {
    const patch: Record<string, unknown> = { status: 'completed', filePath, progress: 1 }
    if (size !== undefined) patch.size = size
    return dbUpdate('download_records', { id }, patch)
}

/**
 * 把「上次没跑完」的记录标记 failed：仅当当前状态仍为传入的 expectedStatus 时才命中，
 * 避免期间被别处改过（如已标 cancelled）仍被覆盖。
 */
export async function failInterruptedDownloadRecord(id: string, expectedStatus: DownloadStatus): Promise<Result<boolean>> {
    return dbUpdate('download_records', { id, status: expectedStatus }, { status: 'failed' })
}

/** 标记已扫过（仅 initDownload 调用） */
export async function markDownloadRecordScanned(id: string): Promise<Result<boolean>> {
    return dbUpdate('download_records', { id }, { scanned: 1 })
}

/** 按 id 删除记录，返回删除行数。 */
export async function deleteDownloadRecordById(id: string): Promise<Result<number>> {
    return dbDelete('download_records', { id })
}

/** 启动清理：取「未成功且未扫过(scanned != 1)」的记录。 */
export async function getUncleanedInterruptedRecords(): Promise<Result<LP.DownloadRecord[]>> {
    return dbQuery<LP.DownloadRecord>(
        `SELECT * FROM download_records WHERE status != 'completed' AND scanned != 1`,
    )
}

/** 启动清理：取所有已完成记录的文件路径（用于排除「正被已完成记录占用」的路径）。 */
export async function getCompletedDownloadFilePaths(): Promise<Result<string[]>> {
    const res = await dbQuery<{ filePath: string }>(
        `SELECT file_path FROM download_records WHERE status = 'completed' AND file_path IS NOT NULL AND file_path != ''`,
    )
    if (!isOk(res)) return res
    return ok(res.value.map((r) => r.filePath))
}
