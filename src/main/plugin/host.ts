import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { db } from '@main/db'
import { log } from '@main/log'
import { formatError } from '@shared/result'
import { createPluginLoader, type PluginLoader } from './loader'
import { createStorageManager, type StorageManager } from './storage'
import { createPluginSDK, type LpSdk } from './sdk'
import { createSandbox, runInSandbox } from './sandbox'

interface PluginRuntime {
    exports: Record<string, unknown>
    commands: Map<string, (...args: unknown[]) => unknown>
    state: PluginState
}

interface ProviderRegistration {
    providerPluginId: string
    targetPluginId: string
    command: string
    priority: number
    handler: (...args: unknown[]) => unknown
}

interface PluginHostApi {
    /** 发现插件并同步数据库（不激活） */
    init(): void
    /** 设置主窗口引用（用于向渲染进程发消息 / 调渲染函数） */
    setMainWindow(win: BrowserWindow | null): void
    /** 激活声明了 onStartup 或 * 的启用插件 */
    activateStartupPlugins(): void
    /** 激活单个插件 */
    activatePlugin(pluginId: string): boolean
    /** 停用单个插件 */
    deactivatePlugin(pluginId: string): void
    /** 执行命令 */
    executeCommand(pluginId: string, command: string, ...args: unknown[]): Promise<unknown>
    /** 启用/禁用插件 */
    setEnabled(pluginId: string, enabled: boolean): void
    /** 卸载插件 */
    uninstallPlugin(pluginId: string): Promise<{ success: boolean; error?: string }>
    /** 获取所有插件信息（供 renderer 展示） */
    getPlugins(): PluginInfo[]
    /** 获取所有活动插件的 contributions */
    getContributions(): { commands: unknown[]; menus: unknown[]; views: unknown[] }
    /** 获取有效命令映射：command → pluginId[] */
    getEffectiveCommandMap(): Record<string, string[]>
    setCommandEnabled(pluginId: string, command: string, enabled: boolean): void
    setProviderEnabled(providerPluginId: string, targetPluginId: string, command: string, enabled: boolean): void
    getStorage(pluginId: string, key: string): unknown
    setStorage(pluginId: string, key: string, value: unknown): void
    getPluginManifest(pluginId: string): PluginManifest | null
    /**
     * 渲染端转发上来的视图消息。
     * - kind='send'：调 `on(action)` 注册的监听，不产生回执（返回 null）
     * - kind='request'：调 `handle(action)` 注册的处理器，await 其返回值作为回执
     */
    handleViewMessage(
        pluginId: string,
        viewId: string,
        msg: ViewMessage,
    ): Promise<ViewReplyPayload | null>
    /** 宿主侧事件广播（@opened / @closed），走 `on(action)` 注册的监听 */
    notifyHostEvent(pluginId: string, action: string, payload: unknown): void
    /** 设置渲染端调用的响应结果（由 ipc 转发） */
    resolveRendererInvoke(payload: { requestId: string; result?: unknown; error?: string }): void
    /** 调用渲染进程函数并等待结果 */
    invokeRenderer(action: string, ...args: unknown[]): Promise<unknown>
}

/** 渲染端 → 主进程的视图消息（iframe 发起的） */
export type ViewMessage =
    | { kind: 'send'; action: string; payload?: unknown }
    | { kind: 'request'; id: string; action: string; payload?: unknown }

/** 主进程 → 渲染端的回执（视图那侧的 request 结果） */
export interface ViewReplyPayload {
    id: string
    ok: boolean
    data?: unknown
    error?: string
}

function formatDate(): string {
    const d = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function safeStringify(a: unknown): string {
    if (typeof a === 'string') return a
    try {
        return typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)
    } catch {
        return String(a)
    }
}

/**
 * 把插件内的相对路径（视图 entry / 图标 icon）解析为绝对 file:// URL。
 * 路径解析统一在主进程做，渲染端零路径处理；解析失败返回空串（调用方按「没有」处理）。
 */
function resolveAssetUrl(dirPath: string, relPath: string): string {
    if (!dirPath || !relPath) return ''
    try {
        return pathToFileURL(join(dirPath, relPath)).href
    } catch {
        return ''
    }
}

export function createPluginHost(): PluginHostApi {
    const loader: PluginLoader = createPluginLoader()
    const storage: StorageManager = createStorageManager()
    let mainWindow: BrowserWindow | null = null

    /**
     * 插件 console 日志转发：写主进程日志（带插件前缀）+ 推送 plugin:console 到渲染进程（插件控制台面板）。
     * 插件内调用 console.log / console.debug 等最终落到这里。
     * debug 只进日志文件。
     */
    function forwardConsole(level: string, pluginId: string, args: unknown[]): void {
        const line = `[plugin:${pluginId}] ${args.map(safeStringify).join(' ')}`
        if (level === 'error') log.error(line)
        else if (level === 'warn') log.warn(line)
        else if (level === 'debug') {
            log.debug(line)
            return
        } else log.info(line)

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('plugin:console', {
                pluginId,
                level,
                args: args.map(safeStringify),
                timestamp: Date.now(),
            })
        }
    }

    /** 运行时插件状态（仅活动插件有条目） */
    const runtimes = new Map<string, PluginRuntime>()
    /** 命令提供者注册表 */
    const providers: ProviderRegistration[] = []
    /** 插件配置缓存：避免 executeCommand 中重复读取 DB */
    const configCache = new Map<string, PluginConfig>()
    /** 渲染端调用的 pending promise 表 */
    const pendingRendererInvokes = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

    function resolveRendererInvoke(payload: { requestId: string; result?: unknown; error?: string }): void {
        const { requestId, result, error } = payload
        const pending = pendingRendererInvokes.get(requestId)
        if (!pending) return
        pendingRendererInvokes.delete(requestId)
        if (error) pending.reject(new Error(error))
        else pending.resolve(result)
    }

    function invokeRenderer(pluginId: string, action: string, ...args: unknown[]): Promise<unknown> {
        return new Promise((resolve, reject) => {
            if (!mainWindow || mainWindow.isDestroyed()) {
                return reject(new Error('主窗口不可用'))
            }
            const requestId = `sdk-${Date.now()}-${Math.random().toString(36).slice(2)}`
            pendingRendererInvokes.set(requestId, { resolve, reject })
            // 带上 pluginId，渲染端执行 view:show / view:close 时要按插件做仲裁
            mainWindow.webContents.send('plugin:sdk-invoke', { requestId, pluginId, action, args })
            setTimeout(() => {
                if (pendingRendererInvokes.has(requestId)) {
                    pendingRendererInvokes.delete(requestId)
                    log.warn(`[plugin] ${pluginId} 的 ${action} 等待渲染进程响应超时（10s）`)
                    reject(new Error(`渲染进程响应超时: ${action}`))
                }
            }, 10_000)
        })
    }

    function readManifest<T = PluginManifest>(manifestRaw: unknown): T {
        return (typeof manifestRaw === 'string' ? JSON.parse(manifestRaw) : manifestRaw) as T
    }

    function init(): void {
        const manifests = loader.discover()
        syncDatabase(manifests)
    }

    /**
     * 将文件系统发现的插件与数据库同步：
     * - 新插件：插入 DB
     * - 已有插件：更新版本/manifest
     * - 数据库中有但文件系统没有的：标记为 error
     */
    function syncDatabase(manifests: PluginManifest[]): void {
        const discoveredIds = new Set(manifests.map((m) => m.id))

        for (const manifest of manifests) {
            const existing = db.find('plugins', { id: manifest.id })
            const dirPath = loader.getDirPath(manifest.id) || ''

            if (!existing) {
                log.info(`[plugin] 发现新插件 ${manifest.id}@${manifest.version}`)
                db.create('plugins', {
                    id: manifest.id,
                    name: manifest.name,
                    version: manifest.version,
                    enabled: 0,
                    dirPath,
                    manifest,
                    state: 'installed',
                    installedAt: formatDate(),
                    updatedAt: formatDate(),
                })
            } else {
                const existingManifestStr = typeof existing.manifest === 'string'
                    ? existing.manifest
                    : JSON.stringify(existing.manifest)
                const hasChanged = existingManifestStr !== JSON.stringify(manifest)
                db.update('plugins', { id: manifest.id }, {
                    name: manifest.name,
                    version: manifest.version,
                    dirPath,
                    manifest,
                    // 如果之前是 error 状态（因文件缺失），恢复为 installed
                    state: existing.state === 'error' ? 'installed' : existing.state,
                    error: existing.state === 'error' ? null : existing.error,
                    // 插件数据有变更时，调整为禁用状态并重置为 installed
                    ...(hasChanged ? { enabled: 0, state: 'installed' } : {}),
                })
            }
        }

        // 标记数据库中存在但文件系统中缺失的插件
        const allDbPlugins = db.query('SELECT id FROM plugins', [])
        for (const row of allDbPlugins) {
            if (!discoveredIds.has(String(row.id))) {
                // 目录没了
                log.warn(`[plugin] ${String(row.id)} 的文件已不存在，标记为 error`)
                db.update('plugins', { id: String(row.id) }, { state: 'error', error: '插件文件缺失' })
            }
        }
    }

    /** 激活声明了 onStartup 或 * 激活事件的启用插件 */
    function activateStartupPlugins(): void {
        const rows = db.query(
            'SELECT id, manifest, enabled FROM plugins WHERE enabled = 1 AND state != \'error\'',
            []
        )
        for (const row of rows) {
            const manifest = readManifest(row.manifest)
            const shouldActivate = manifest.activationEvents.some(
                (e) => e === '*' || e === 'onStartup'
            )
            if (shouldActivate) activatePlugin(String(row.id))
        }
    }

    /**
     * 激活插件：读取源码 → 创建 SDK → 创建沙箱 → 执行 → 调用 activate()
     */
    function activatePlugin(pluginId: string): boolean {
        if (runtimes.has(pluginId)) return true

        const source = loader.getSource(pluginId)
        if (!source) {
            setPluginError(pluginId, '无法读取插件源码')
            return false
        }

        // 从 DB 读取 manifest，用于校验命令注册是否在声明范围内
        const pluginRow = db.find('plugins', { id: pluginId })
        const manifest = pluginRow ? readManifest(pluginRow.manifest) : null
        const declaredCommands = new Set(
            (manifest?.contributions?.commands || []).map((c) => c.command)
        )
        const declaredProviders = new Set(
            (manifest?.contributions?.providers || []).map(
                (p) => `${p.targetPlugin}:${p.command}`
            )
        )

        const runtime: PluginRuntime = {
            exports: {},
            commands: new Map(),
            state: 'inactive',
        }

        // 命令注册回调：插件调用 lp.commands.register() 时存入此 Map。
        // 只允许注册 manifest 中声明过的命令，未声明的静默忽略并记录警告。
        const registerCommand = (command: string, handler: (...args: unknown[]) => unknown) => {
            if (!command.startsWith('__') && !declaredCommands.has(command)) {
                return
            }
            runtime.commands.set(command, handler)
        }

        const registerProvider = (
            targetPluginId: string,
            command: string,
            options: { priority?: number; handler: (...args: unknown[]) => unknown }
        ) => {
            const key = `${targetPluginId}:${command}`
            if (!declaredProviders.has(key)) {
                return
            }
            if (typeof options.handler !== 'function') {
                return
            }
            providers.push({
                providerPluginId: pluginId,
                targetPluginId,
                command,
                priority: options.priority ?? 0,
                handler: options.handler,
            })
        }

        const sdk: LpSdk = createPluginSDK({
            pluginId,
            pluginName: manifest?.name ?? pluginId,
            storage,
            mainWindow,
            registerCommand,
            registerProvider,
            invokeRenderer: (action: string, ...args: unknown[]) => invokeRenderer(pluginId, action, ...args),
        })

        try {
            const context = createSandbox(pluginId, sdk, (level, args) =>
                forwardConsole(level, pluginId, args)
            )
            const exports = runInSandbox(context, source, pluginId)
            runtime.exports = exports

            // 调用 activate 生命周期钩子
            if (typeof exports.activate === 'function') {
                ;(exports.activate as () => void)()
            }

            runtime.state = 'active'
            runtimes.set(pluginId, runtime)
            db.update('plugins', { id: pluginId }, { state: 'active', error: null })
            log.info(`[plugin] ${pluginId} 已激活`)
            return true
        } catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e)
            // 插件是第三方代码，激活失败必须留完整堆栈
            log.error(`[plugin] ${pluginId} 激活失败\n${formatError(e)}`)
            setPluginError(pluginId, errorMsg)
            return false
        }
    }

    /** 停用插件：调用 deactivate() → 移除运行时 */
    function deactivatePlugin(pluginId: string): void {
        const runtime = runtimes.get(pluginId)
        if (!runtime) return

        try {
            if (runtime.exports && typeof runtime.exports.deactivate === 'function') {
                ;(runtime.exports.deactivate as () => void)()
            }
        } catch (e) {
            // deactivate 是插件自己的清理逻辑，出错不能拦住停用，但要看得到
            log.warn(`[plugin] ${pluginId} deactivate 出错\n${formatError(e)}`)
        }

        const kept = providers.filter((p) => p.providerPluginId !== pluginId)
        providers.length = 0
        providers.push(...kept)

        runtimes.delete(pluginId)
        db.update('plugins', { id: pluginId }, { state: 'inactive' })
        log.info(`[plugin] ${pluginId} 已停用`)
    }

    /**
     * 执行命令。三阶段流程：
     * 1. 尝试所有已启用 provider（无论原始命令是否禁用），成功则返回
     * 2. provider 全部未处理 → 检查原始命令启停，禁用则抛错
     * 3. 调用原始插件 handler
     */
    async function executeCommand(pluginId: string, command: string, ...args: unknown[]): Promise<unknown> {
        // 阶段 1：尝试所有已启用的 provider（无论原始命令是否禁用）
        const enabledProviders = providers
            .filter((p) => p.targetPluginId === pluginId && p.command === command && isProviderEnabled(p))
            .sort((a, b) => b.priority - a.priority)

        for (const provider of enabledProviders) {
            if (!runtimes.has(provider.providerPluginId)) {
                const row = db.find('plugins', { id: provider.providerPluginId })
                if (!row || !row.enabled || !activatePlugin(provider.providerPluginId)) continue
            }
            try {
                // provider 返回值即视为已处理，直接作为结果返回
                return await provider.handler(...args)
            } catch (e) {
                // 这里必须记：下游只会归并成「所有 provider 均未能处理」，
                // 看不出是谁、为什么
                log.warn(
                    `[plugin] provider ${provider.providerPluginId} 处理 ${pluginId}:${command} 失败\n${formatError(e)}`,
                )
            }
        }

        // 阶段 2：provider 全部未处理 → 检查原始命令启停
        if (!isCommandEnabled(pluginId, command)) {
            throw new Error(
                enabledProviders.length > 0
                    ? `所有 provider 均未能处理命令 ${pluginId}:${command}，且原始命令已禁用`
                    : `命令 ${pluginId}:${command} 已禁用且无可用 provider`
            )
        }

        // 阶段 3：调用原始插件
        if (!runtimes.has(pluginId)) {
            const pluginRow = db.find('plugins', { id: pluginId })
            if (!pluginRow) {
                throw new Error(`插件 ${pluginId} 未找到`)
            }
            if (!pluginRow.enabled) {
                throw new Error(`插件 ${pluginId} 未启用`)
            }
            if (!activatePlugin(pluginId)) {
                throw new Error(`插件 ${pluginId} 激活失败`)
            }
        }

        const runtime = runtimes.get(pluginId)!
        const handler = runtime.commands.get(command)
        if (!handler) {
            throw new Error(`插件 ${pluginId} 未注册命令: ${command}`)
        }

        return await handler(...args)
    }

    /** 启用/禁用插件 */
    function setEnabled(pluginId: string, enabled: boolean): void {
        db.update('plugins', { id: pluginId }, { enabled: enabled ? 1 : 0 })
        log.info(`[plugin] ${pluginId} 已${enabled ? '启用' : '禁用'}`)
        configCache.delete(pluginId)
        if (enabled) {
            // 检查是否需要立即激活
            const row = db.find('plugins', { id: pluginId })
            if (row) {
                const manifest = readManifest(row.manifest)
                const shouldActivate = manifest.activationEvents.some(
                    (e) => e === '*' || e === 'onStartup'
                )
                if (shouldActivate) activatePlugin(pluginId)
            }
        } else {
            deactivatePlugin(pluginId)
        }
    }

    /** 卸载插件：停用 → 删除存储 → 删除数据库记录 → 删除文件 */
    async function uninstallPlugin(pluginId: string): Promise<{ success: boolean; error?: string }> {
        try {
            const row = db.find('plugins', { id: pluginId })
            if (!row) {
                return { success: false, error: '插件不存在' }
            }

            deactivatePlugin(pluginId)

            db.delete('plugin_storage', { pluginId })
            db.delete('plugins', { id: pluginId })
            configCache.delete(pluginId)

            if (row.dirPath) {
                const dirPath = String(row.dirPath)
                const fs = await import('node:fs')
                if (fs.existsSync(dirPath)) {
                    fs.rmSync(dirPath, { recursive: true, force: true })
                }
            }

            log.info(`[plugin] ${pluginId} 已卸载`)
            return { success: true }
        } catch (e) {
            log.error(`[plugin] ${pluginId} 卸载失败\n${formatError(e)}`)
            return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
    }

    /** 获取所有插件信息（供 renderer 展示） */
    function getPlugins(): PluginInfo[] {
        const rows = db.query('SELECT * FROM plugins', [])
        return rows.map((row) => {
            const runtime = runtimes.get(String(row.id))
            const manifest = readManifest(row.manifest)
            const declaredCommands = manifest.contributions?.commands || []
            const declaredProviders = manifest.contributions?.providers || []
            const config = (row.config ? readManifest<PluginConfig>(row.config) : {}) as PluginConfig
            const dirPath = String(row.dirPath)
            // 图标与视图 entry 一样：路径解析留在主进程，渲染端只拿到可直接用的 URL
            const iconUrl = resolveAssetUrl(dirPath, manifest?.icon ?? '')
            return {
                id: String(row.id),
                name: String(row.name),
                label: manifest?.label,
                icon: manifest?.icon,
                iconUrl: iconUrl || undefined,
                version: String(row.version),
                description: manifest?.description,
                author: manifest?.author,
                homePage: manifest?.homePage,
                updateTime: manifest?.updateTime,
                enabled: !!row.enabled,
                state: (runtime?.state || String(row.state) || 'installed') as PluginState,
                error: row.error ? String(row.error) : undefined,
                dirPath: String(row.dirPath),
                installedAt: row.installedAt ? String(row.installedAt) : undefined,
                updatedAt: row.updatedAt ? String(row.updatedAt) : undefined,
                commands: declaredCommands,
                providers: declaredProviders,
                views: (manifest.contributions?.views || []).map((v) => ({
                    ...v,
                    pluginId: String(row.id),
                    entryUrl:
                        resolveAssetUrl(String(row.dirPath), v.entry) +
                        `?pluginId=${encodeURIComponent(String(row.id))}` +
                        `&viewId=${encodeURIComponent(v.id)}`,
                })),
                config,
            }
        })
    }

    /** 获取所有活动插件的 contributions */
    function getContributions(): { commands: unknown[]; menus: unknown[]; views: unknown[] } {
        const commands: unknown[] = []
        const menus: unknown[] = []
        const views: unknown[] = []

        const rows = db.query('SELECT id, manifest FROM plugins WHERE enabled = 1 AND state != \'error\'', [])
        for (const row of rows) {
            const manifest = readManifest(row.manifest)
            if (manifest.contributions?.commands) {
                commands.push(...manifest.contributions.commands.map((c) => ({ ...c, pluginId: String(row.id) })))
            }
            if (manifest.contributions?.menus) {
                menus.push(...manifest.contributions.menus.map((m) => ({ ...m, pluginId: String(row.id) })))
            }
            if (manifest.contributions?.views) {
                const dirPath = loader.getDirPath(String(row.id)) || ''
                views.push(
                    ...manifest.contributions.views.map((v) => ({
                        ...v,
                        pluginId: String(row.id),
                        entryUrl:
                            resolveAssetUrl(dirPath, v.entry) +
                            `?pluginId=${encodeURIComponent(String(row.id))}` +
                            `&viewId=${encodeURIComponent(v.id)}`,
                    }))
                )
            }
        }

        return { commands, menus, views }
    }

    /**
     * 处理视图消息（从 renderer iframe 转发过来）。
     * 注意不是按 viewId 查 handler —— handler 是按 action 注册的，
     * viewId 只作为上下文塞进 event（回执由调用方按 viewId 路由回 iframe）。
     */
    async function handleViewMessage(
        pluginId: string,
        viewId: string,
        msg: ViewMessage,
    ): Promise<ViewReplyPayload | null> {
        const runtime = runtimes.get(pluginId)
        if (!runtime) return null
        const action = typeof msg?.action === 'string' ? msg.action : ''
        if (!action) return null

        const event: ViewEvent = {
            action,
            payload: msg.payload,
            pluginId,
            viewId,
            timestamp: Date.now(),
        }

        if (msg.kind === 'send') {
            const listener = runtime.commands.get(`__view_listener__:${action}`)
            if (listener) {
                try {
                    listener(event)
                } catch (e) {
                }
            }
            return null
        }

        // kind === 'request'：await 处理器返回值作为回执；throw 即失败响应
        const handler = runtime.commands.get(`__view_handler__:${action}`)
        if (!handler) {
            return { id: msg.id, ok: false, error: `插件未注册 handle("${action}")` }
        }
        try {
            const data = await handler(event)
            return { id: msg.id, ok: true, data }
        } catch (e) {
            return { id: msg.id, ok: false, error: e instanceof Error ? e.message : String(e) }
        }
    }

    /** 宿主事件广播（@opened / @closed）：复用 on(action) 注册的监听 */
    function notifyHostEvent(pluginId: string, action: string, payload: unknown): void {
        const runtime = runtimes.get(pluginId)
        if (!runtime) return
        const listener = runtime.commands.get(`__view_listener__:${action}`)
        if (!listener) return
        const p = payload as { viewId?: string } | undefined
        try {
            listener({
                action,
                payload,
                pluginId,
                viewId: typeof p?.viewId === 'string' ? p.viewId : '',
                timestamp: Date.now(),
            } satisfies ViewEvent)
        } catch (e) {
        }
    }

    function getStorage(pluginId: string, key: string): unknown {
        return storage.get(pluginId, key)
    }

    function setStorage(pluginId: string, key: string, value: unknown): void {
        storage.set(pluginId, key, value)
    }

    function getPluginManifest(pluginId: string): PluginManifest | null {
        const row = db.find('plugins', { id: pluginId })
        if (!row) return null
        return readManifest(row.manifest)
    }

    // ---- 命令与 Provider 启停配置 ----

    function getPluginConfig(pluginId: string): PluginConfig {
        const cached = configCache.get(pluginId)
        if (cached) return cached
        const row = db.find('plugins', { id: pluginId })
        if (!row?.config) return {}
        const config = readManifest<PluginConfig>(row.config)
        configCache.set(pluginId, config)
        return config
    }

    function setPluginConfig(pluginId: string, config: PluginConfig): void {
        db.update('plugins', { id: pluginId }, { config: JSON.stringify(config) })
        configCache.set(pluginId, config)
    }

    function isCommandEnabled(pluginId: string, command: string): boolean {
        const config = getPluginConfig(pluginId)
        return !config.disabledCommands?.includes(command)
    }

    function isProviderEnabled(p: ProviderRegistration): boolean {
        const config = getPluginConfig(p.providerPluginId)
        return !config.disabledProviders?.includes(`${p.targetPluginId}:${p.command}`)
    }

    /**
     * 获取有效命令映射：command → pluginId[]
     * 综合考虑命令启停和 provider 声明。
     */
    function getEffectiveCommandMap(): Record<string, string[]> {
        const map: Record<string, string[]> = {}

        const rows = db.query(
            'SELECT id, manifest, enabled, config FROM plugins WHERE enabled = 1 AND state != \'error\'',
            []
        )

        // 收集所有已启用插件的 provider 声明覆盖情况
        const providerCoverage = new Set<string>()
        for (const row of rows) {
            const manifest = readManifest(row.manifest)
            const config = readManifest<PluginConfig>(row.config)

            for (const prov of manifest.contributions?.providers || []) {
                const provKey = `${prov.targetPlugin}:${prov.command}`
                const provEnabled = !config.disabledProviders?.includes(provKey)
                if (provEnabled) {
                    providerCoverage.add(provKey)
                }
            }
        }

        // 构建有效命令映射
        for (const row of rows) {
            const manifest = readManifest(row.manifest)
            const config = readManifest<PluginConfig>(row.config)

            for (const cmd of manifest.contributions?.commands || []) {
                const commandEnabled = !config.disabledCommands?.includes(cmd.command)
                const hasProvider = providerCoverage.has(`${row.id}:${cmd.command}`)

                if (commandEnabled || hasProvider) {
                    if (!map[cmd.command]) map[cmd.command] = []
                    map[cmd.command].push(String(row.id))
                }
            }
        }

        return map
    }

    function setCommandEnabled(pluginId: string, command: string, enabled: boolean): void {
        const config = getPluginConfig(pluginId)
        if (!config.disabledCommands) config.disabledCommands = []
        if (enabled) {
            config.disabledCommands = config.disabledCommands.filter((c) => c !== command)
        } else if (!config.disabledCommands.includes(command)) {
            config.disabledCommands.push(command)
        }
        setPluginConfig(pluginId, config)
        log.info(`[plugin] ${pluginId} 的命令 ${command} 已${enabled ? '启用' : '禁用'}`)
    }

    function setProviderEnabled(
        providerPluginId: string,
        targetPluginId: string,
        command: string,
        enabled: boolean
    ): void {
        const config = getPluginConfig(providerPluginId)
        if (!config.disabledProviders) config.disabledProviders = []
        const key = `${targetPluginId}:${command}`
        if (enabled) {
            config.disabledProviders = config.disabledProviders.filter((k) => k !== key)
        } else if (!config.disabledProviders.includes(key)) {
            config.disabledProviders.push(key)
        }
        setPluginConfig(providerPluginId, config)
        log.info(
            `[plugin] provider ${providerPluginId} → ${key} 已${enabled ? '启用' : '禁用'}`,
        )
    }

    function setPluginError(pluginId: string, error: string): void {
        db.update('plugins', { id: pluginId }, { state: 'error', error })
    }

    function setMainWindow(win: BrowserWindow | null): void {
        mainWindow = win
    }

    return {
        init,
        setMainWindow,
        activateStartupPlugins,
        activatePlugin,
        deactivatePlugin,
        executeCommand,
        setEnabled,
        uninstallPlugin,
        getPlugins,
        getContributions,
        getEffectiveCommandMap,
        setCommandEnabled,
        setProviderEnabled,
        getStorage,
        setStorage,
        getPluginManifest,
        handleViewMessage,
        notifyHostEvent,
        resolveRendererInvoke,
        invokeRenderer,
    }
}

export const pluginHost = createPluginHost()

export function initPluginHost(): void {
    // 启动期：发现插件并同步数据库
    pluginHost.init()
}
