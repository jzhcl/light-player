/** 构造成功结果。 */
export const ok = <T>(value: T): Result<T> => ({ success: true, value })

/** 构造失败结果（中文 error 信息，禁止用 throw 传递失败）。 */
export const fail = (error: string): Result<never> => ({ success: false, error })

/**
 * 判定是否“非失败”，并在实参是 `Result<T>` 时把类型收窄到成功形态（两个分支都能直接读字段）：
 * ```ts
 * if (!isOk(r)) return fail(r.error)   // r: { success: false; error: string }
 * const v = r.value                    // r: { success: true; value: T }
 * ```
 */
export function isOk<T>(r: Result<T>): r is { success: true; value: T }
export function isOk(r: unknown): boolean
export function isOk(r: unknown): boolean {
    return !(typeof r === 'object' && r !== null && 'success' in r && !(r as Result<unknown>).success)
}

/** 错误 → 带堆栈的文本 */
export function formatError(err: unknown): string {
    if (err instanceof Error) return err.stack ?? err.message
    return String(err)
}

/** 构造失败结果，并把失败详情写进日志 */
export function failWithLog(
    logger: { error: (message: string) => void },
    tag: string,
    op: string,
    detail: string,
    err: unknown,
): Result<never> {
    logger.error(`[${tag}] ${op} 失败\n${detail}\n${formatError(err)}`)
    return fail(err instanceof Error ? err.message : String(err))
}
