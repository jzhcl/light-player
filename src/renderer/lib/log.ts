// 渲染进程日志：不直接写日志，而是经 IPC 把日志发送给主进程，

import { formatError } from '@shared/result'

const sendLog = (channel: string, params: unknown[]): void => {
    window.api.invoke(channel, ...params).catch(() => {
    })
}

const info = (...params: unknown[]): void => sendLog('logInfo', params)
const success = (...params: unknown[]): void => sendLog('logInfo', params)
const warn = (...params: unknown[]): void => sendLog('logWarn', params)
const error = (...params: unknown[]): void => sendLog('logError', params)
const debug = (...params: unknown[]): void => sendLog('logDebug', params)
const verbose = (...params: unknown[]): void => sendLog('logVerbose', params)

export const rlog = {
    info,
    success,
    warn,
    error,
    debug,
    verbose
}

/** 批量 id 的日志文本：超过 `limit` 个只列前几个 + 总数 */
export function idList(ids: readonly string[], limit = 5): string {
    if (ids.length === 0) return '[]'
    const head = ids.slice(0, limit).join(', ')
    return ids.length > limit ? `[${head}, …共 ${ids.length} 个]` : `[${head}]`
}

/** 装渲染进程的全局异常钩子 */
export function installErrorHooks(): void {
    window.addEventListener('error', (e) => {
        if (e.error) {
            error(`[uncaught] ${e.message}\n${formatError(e.error)}`)
            return
        }
        const where = `${e.filename || '(unknown)'}:${e.lineno ?? 0}:${e.colno ?? 0}`
        error(`[uncaught] 资源加载失败 ${where}`)
    })

    window.addEventListener('unhandledrejection', (e) => {
        error(`[unhandled-rejection] ${formatError((e as PromiseRejectionEvent).reason)}`)
    })
}
