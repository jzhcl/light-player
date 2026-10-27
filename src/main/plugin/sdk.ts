// 插件 SDK 工厂：为每个插件实例创建隔离的 lp 命名空间对象

import type { BrowserWindow } from 'electron'
import axiosLib from 'axios'
import type { AxiosInstance } from 'axios'
import { fail } from '@shared/result'
import type { StorageManager } from './storage'

export interface SDKDeps {
    pluginId: string
    /** 插件显示名（manifest.name），用作消息前缀；缺省回落到 pluginId */
    pluginName: string
    storage: StorageManager
    mainWindow: BrowserWindow | null
    /** 注册命令的回调，host 负责维护命令映射表 */
    registerCommand: (command: string, handler: (...args: unknown[]) => unknown) => void
    /** 注册命令提供者的回调，允许为其他插件的命令提供增强服务 */
    registerProvider: (
        targetPluginId: string,
        command: string,
        options: { priority?: number; handler: (...args: unknown[]) => unknown }
    ) => void
    /** 调用渲染进程函数并等待结果 */
    invokeRenderer: (action: string, ...args: unknown[]) => Promise<unknown>
}

/** 后端发起 request 的默认超时 */
const VIEW_REQUEST_TIMEOUT = 15000

/** 等待视图回执的请求（key = 请求 id，已含 pluginId 前缀） */
const pendingViewRequests = new Map<
    string,
    { resolve: (r: Result<unknown>) => void; timer: ReturnType<typeof setTimeout> }
>()

/**
 * 视图对 `lp.ui.request()` 的回执。由主进程 IPC 层调用（渲染端转发上来的）。
 */
export function resolvePluginViewRequest(
    id: string,
    reply: { ok: boolean; data?: unknown; error?: string },
): void {
    const pending = pendingViewRequests.get(id)
    if (!pending) return
    pendingViewRequests.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(reply.ok ? ({ success: true, value: reply.data } as Result<unknown>) : fail(reply.error ?? '视图返回失败'))
}

/**
 * 注入到插件沙箱的 lp 命名空间（主进程专属类型定义）。
 * 收敛后的能力：storage / commands / ui / axiosInstance / song / lyric / playlist
 */
export interface LpSdk {
    storage: {
        get(key: string): unknown
        set(key: string, value: unknown): void
        delete(key: string): void
        keys(): string[]
    }
    commands: {
        register(command: string, handler: (...args: unknown[]) => unknown): void
        registerProvider(
            targetPluginId: string,
            command: string,
            options: { priority?: number; handler: (...args: unknown[]) => unknown }
        ): void
    }
    ui: {
        message: {
            info(text: string): void
            success(text: string): void
            warning(text: string): void
            error(text: string): void
        }
        /** 打开视图（有回执）；`data` 随 lp:init 下发给视图 */
        showView(viewId: string, options?: PluginShowViewOptions): Promise<ShowViewResult>
        /** 关闭视图（有回执）；settings 视图返回 rejected: not-closable */
        closeView(viewId: string): Promise<CloseViewResult>
        /** 本插件的某个视图此刻是否被插件层占用（同步，基于宿主广播的状态镜像） */
        isViewOpen(viewId: string): boolean
        /** 向视图单向推送（未挂载则丢弃，宿主会打 warn） */
        send(viewId: string, action: string, payload?: unknown): void
        /** 向视图发起请求并等回执（未挂载立即失败；超时 15s） */
        request(viewId: string, action: string, payload?: unknown): Promise<Result<unknown>>
        /** 处理视图发起的请求：返回值即响应，throw 即失败响应 */
        handle(action: string, handler: (event: ViewEvent) => unknown): void
        /** 接收视图的单向事件；`@` 开头为宿主系统事件（@opened / @closed） */
        on(action: string, handler: (event: ViewEvent) => void): void
    }
    axiosInstance: AxiosInstance
    song: {
        create(data: LP.Plugin.Song): Promise<string | undefined>
        update(id: string, data: Partial<LP.Plugin.Song>): Promise<unknown>
        delete(id: string): Promise<unknown>
    }
    lyric: {
        update(songId: string, data: LP.Plugin.SongLyric): Promise<unknown>
    }
    playlist: {
        /** 宿主全部歌单（内置「我喜欢」写死在前，其余整行透传），pic 已收敛成可渲染 URL */
        getAll(): Promise<LP.Plugin.PlaylistInfo[]>
        create(data: LP.Plugin.Playlist): Promise<string | undefined>
        delete(id: string): Promise<boolean>
        /** 往 'liked' 加歌 = 标记喜欢 */
        addSong(playlistId: string, songId: string): Promise<unknown>
        /** 从 'liked' 移除 = 取消喜欢 */
        removeSong(playlistId: string, songId: string): Promise<unknown>
    }
}

/**
 * 为指定插件创建 SDK 实例。
 * 每个插件拥有独立的 SDK 对象，存储写入自动加上插件前缀隔离。
 */
export function createPluginSDK(deps: SDKDeps): LpSdk {
    const {
        pluginId,
        pluginName,
        storage,
        mainWindow,
        registerCommand,
        registerProvider,
        invokeRenderer,
    } = deps

    let requestSeq = 0

    function sendView(type: string, viewId: string, data?: unknown): void {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('plugin:view', { type, pluginId, viewId, data })
        }
    }

    function sendMessage(type: 'info' | 'success' | 'warn' | 'error', text: string): void {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('plugin:message', {
                type,
                pluginId,
                pluginName,
                text,
            })
        }
    }

    /**
     * 视图占用状态镜像：`isViewOpen` 要同步返回，所以不能每次去问渲染端。
     * 更新点有三处：自己 showView 成功、自己 closeView 成功、宿主广播的 @opened/@closed。
     */
    const openViewIds = new Set<string>()

    const axiosInstance = axiosLib.create()

    return {
        // ---- 持久化存储（同步，按插件隔离）----
        storage: {
            get: (key: string) => storage.get(pluginId, key),
            set: (key: string, value: unknown) => storage.set(pluginId, key, value),
            delete: (key: string) => storage.delete(pluginId, key),
            keys: () => storage.keys(pluginId),
        },

        // ---- 命令注册 ----
        commands: {
            register: (command: string, handler: (...args: unknown[]) => unknown) => {
                registerCommand(command, handler)
            },
            registerProvider: (
                targetPluginId: string,
                command: string,
                options: { priority?: number; handler: (...args: unknown[]) => unknown }
            ) => {
                registerProvider(targetPluginId, command, options)
            },
        },

        // ---- UI----
        ui: {
            message: {
                info: (text: string) => sendMessage('info', text),
                success: (text: string) => sendMessage('success', text),
                // 方法名用 warning，映射到渲染端的 warn
                warning: (text: string) => sendMessage('warn', text),
                error: (text: string) => sendMessage('error', text),
            },

            showView: async (viewId: string, options?: PluginShowViewOptions) => {
                const result = (await invokeRenderer('view:show', viewId, options)) as
                    | ShowViewResult
                    | undefined
                const normalized: ShowViewResult = result ?? { status: 'rejected', reason: 'unknown-view' }
                if (normalized.status === 'opened') openViewIds.add(viewId)
                return normalized
            },

            closeView: async (viewId: string) => {
                const result = (await invokeRenderer('view:close', viewId)) as CloseViewResult | undefined
                const normalized: CloseViewResult = result ?? { status: 'rejected', reason: 'not-open' }
                if (normalized.status === 'closed') openViewIds.delete(viewId)
                return normalized
            },

            isViewOpen: (viewId: string) => openViewIds.has(viewId),

            send: (viewId: string, action: string, payload?: unknown) => {
                sendView('push', viewId, { action, payload })
            },

            request: (viewId: string, action: string, payload?: unknown) => {
                const id = `${pluginId}#${++requestSeq}`
                return new Promise<Result<unknown>>((resolve) => {
                    const timer = setTimeout(() => {
                        pendingViewRequests.delete(id)
                        resolve(fail(`视图响应超时（${VIEW_REQUEST_TIMEOUT / 1000}s）`))
                    }, VIEW_REQUEST_TIMEOUT)
                    pendingViewRequests.set(id, { resolve, timer })
                    sendView('request', viewId, { id, action, payload })
                })
            },

            // 请求处理器与事件监听分开注册：合并只能靠「handler 有没有返回值」隐式区分
            handle: (action: string, handler: (event: ViewEvent) => unknown) => {
                registerCommand(`__view_handler__:${action}`, handler as (...args: unknown[]) => unknown)
            },

            on: (action: string, handler: (event: ViewEvent) => void) => {
                registerCommand(`__view_listener__:${action}`, handler as (...args: unknown[]) => unknown)
            },
        },

        // ---- 独立 axios 实例（HTTP 请求）----
        axiosInstance,

        // ---- 歌曲数据写操作（异步，经渲染进程执行）----
        song: {
            create: async (data: LP.Plugin.Song): Promise<string | undefined> => {
                data.pluginId = pluginId
                const result = await invokeRenderer('song:create', data)
                return (result as { id?: string } | undefined)?.id
            },
            update: async (id: string, data: Partial<LP.Plugin.Song>): Promise<unknown> =>
                invokeRenderer('song:update', id, data),
            delete: async (id: string): Promise<unknown> => invokeRenderer('song:delete', id),
        },

        // ---- 歌词数据写操作（异步，经渲染进程执行）----
        lyric: {
            update: async (songId: string, data: LP.Plugin.SongLyric): Promise<unknown> =>
                invokeRenderer('lyric:update', songId, data),
        },

        // ---- 歌单数据读写（异步，经渲染进程执行）----
        playlist: {
            getAll: async (): Promise<LP.Plugin.PlaylistInfo[]> =>
                (await invokeRenderer('playlist:getAll')) as LP.Plugin.PlaylistInfo[],
            create: async (data: LP.Plugin.Playlist): Promise<string | undefined> => {
                data.pluginId = pluginId
                const result = await invokeRenderer('playlist:create', data)
                return (result as { id?: string } | undefined)?.id
            },
            delete: async (id: string): Promise<boolean> => {
                const PROTECTED = ['liked']
                if (PROTECTED.includes(id)) {
                    return false
                }
                return Boolean(await invokeRenderer('playlist:delete', id))
            },
            addSong: async (playlistId: string, songId: string): Promise<unknown> =>
                invokeRenderer('playlist:addSong', playlistId, songId),
            removeSong: async (playlistId: string, songId: string): Promise<unknown> =>
                invokeRenderer('playlist:removeSong', playlistId, songId),
        },
    }
}
