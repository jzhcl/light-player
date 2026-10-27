import { app } from 'electron'
import { join, dirname } from 'node:path'
import { mkdirSync } from 'node:fs'

/** 开发模式下主进程源码的静态资源目录（构建后由 vite 插件复制到 dist/static）。 */
const DEV_STATIC_DIR = join(app.getAppPath(), 'src', 'shared', 'assets')

export const PATHS = {
    /** 应用用户数据目录 */
    getUserData: () => app.getPath('userData'),

    /** 插件目录（渲染端插件 View 的资源根，主进程 loader 自用） */
    getPlugins: () => join(app.getPath('userData'), 'plugins'),

    /** 日志目录 */
    getLogs: () => join(app.getPath('userData'), 'logs'),

    /** 主数据库文件路径 */
    getDatabase: () => join(app.getPath('userData'), 'db', 'light-player.db'),

    /** 主进程可读的静态资源根目录 */
    getStatic: () => (app.isPackaged ? join(process.resourcesPath, 'static') : DEV_STATIC_DIR),
} as const

/**
 * 应用就绪后创建主进程自身必须存在的目录
 */
export function ensureAppDirectories(): void {
    const dirs = [
        PATHS.getUserData(),
        PATHS.getPlugins(),
        PATHS.getLogs(),
        dirname(PATHS.getDatabase()),
    ]
    for (const dir of dirs) {
        mkdirSync(dir, { recursive: true })
    }
}
