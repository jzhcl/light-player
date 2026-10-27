import electronLog from 'electron-log'
import { join } from 'node:path'
import { PATHS } from '@main/constants/paths'


const logDir = PATHS.getLogs()

const today = (): string => {
    const now = new Date()
    return [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
    ].join('-')
}

const logger = electronLog.create({ logId: 'lightplayer' })

logger.transports.file.resolvePathFn = () => join(logDir, `${today()}.log`)

const LOG_FORMAT = '[{h}:{i}:{s}.{ms}] [{level}]{scope} {text}'
logger.transports.file.format = LOG_FORMAT
logger.transports.console.format = LOG_FORMAT
logger.scope.labelPadding = false

logger.transports.file.level = 'debug'
logger.transports.console.level = 'debug'

// 主进程日志：log.info / log.debug / log.error ... 前缀 [Main]
export const log = logger.scope('Main')

// 渲染进程日志（经 IPC 由主进程转调）：rInfo / rDebug / rError ... 前缀 [Renderer]
const renderer = logger.scope('Renderer')

export const rInfo = (...params: unknown[]): void => {
    renderer.info(...params)
}
export const rDebug = (...params: unknown[]): void => {
    renderer.debug(...params)
}
export const rWarn = (...params: unknown[]): void => {
    renderer.warn(...params)
}
export const rError = (...params: unknown[]): void => {
    renderer.error(...params)
}
export const rVerbose = (...params: unknown[]): void => {
    renderer.verbose(...params)
}
