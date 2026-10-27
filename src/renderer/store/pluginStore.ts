import { create } from 'zustand'


export interface PluginConsoleLog {
    pluginId: string
    level: string
    args: string[]
    timestamp: number
}

interface PluginContributions {
    commands: unknown[]
    menus: unknown[]
    views: unknown[]
}

/** plugin 层当前打开的视图 */
export interface ActiveView {
    pluginId: string
    viewId: string
    container: 'modal' | 'settings'
    entryUrl: string
    title?: string
    /** 视图尺寸，由插件 contributions.views[].size 定义，缺省回退到默认值（仅 modal） */
    size?: { width: number; height: number }
    /** 是否允许按 ESC / 点遮罩关闭（仅 modal）：showView options > manifest 声明 > true */
    escClose?: boolean
    /** showView 传入的初始载荷，随 lp:init 下发给视图 */
    data?: unknown
    /** 打开时间戳（调试 / 排序用） */
    openedAt: number
}

/** openView 的结果（与 SDK 的 ShowResult 同形） */
export type OpenViewOutcome =
    | { status: 'opened' }
    | { status: 'opened'; reused: true }
    | {
          status: 'rejected'
          reason: 'occupied' | 'unknown-view'
          occupant?: { pluginId: string; viewId: string }
      }

interface PluginStore {
    /** 已发现/已安装的插件列表 */
    plugins: PluginInfo[]
    /** 所有活动插件的 contributions */
    contributions: PluginContributions
    /** 有效命令映射 command → pluginId[] */
    commandMap: Record<string, string[]>
    /** 插件 console 日志 */
    consoleLogs: PluginConsoleLog[]
    /** plugin 层当前打开的视图 */
    activeView: ActiveView | null

    setPlugins: (list: PluginInfo[]) => void
    setContributions: (c: PluginContributions) => void
    setCommandMap: (m: Record<string, string[]>) => void
    upsertPlugin: (p: PluginInfo) => void
    removePlugin: (id: string) => void
    appendConsoleLog: (log: PluginConsoleLog) => void
    clearConsoleLogs: () => void
    /**
     * 打开 modal 视图。同步返回判定结果 —— 调用方（pluginIpc）据此回执给插件。
     * settings 视图不走这里（由路由控制）。
     */
    openView: (
        pluginId: string,
        viewId: string,
        options?: PluginShowViewOptions,
    ) => OpenViewOutcome
    /** 关闭视图；返回是否真的关掉了 */
    closeView: (pluginId: string, viewId: string) => boolean
}

const MAX_CONSOLE_LOGS = 500

export const usePluginStore = create<PluginStore>((set, get) => ({
    plugins: [],
    contributions: { commands: [], menus: [], views: [] },
    commandMap: {},
    consoleLogs: [],
    activeView: null,

    setPlugins: (list) => set({ plugins: list }),
    setContributions: (c) => set({ contributions: c }),
    setCommandMap: (m) => set({ commandMap: m }),
    upsertPlugin: (p) =>
        set((s) => {
            const idx = s.plugins.findIndex((x) => x.id === p.id)
            if (idx === -1) return { plugins: [...s.plugins, p] }
            const next = s.plugins.slice()
            next[idx] = p
            return { plugins: next }
        }),
    removePlugin: (id) => set((s) => ({ plugins: s.plugins.filter((p) => p.id !== id) })),
    appendConsoleLog: (log) =>
        set((s) => {
            const next = [...s.consoleLogs, log]
            return { consoleLogs: next.length > MAX_CONSOLE_LOGS ? next.slice(next.length - MAX_CONSOLE_LOGS) : next }
        }),
    clearConsoleLogs: () => set({ consoleLogs: [] }),

    openView: (pluginId, viewId, options) => {
        const state = get()
        const current = state.activeView

        // 幂等：同一个视图重复打开不重建 iframe（否则插件会丢状态、重走一遍初始化）
        if (current && current.pluginId === pluginId && current.viewId === viewId) {
            return { status: 'opened', reused: true }
        }

        // plugin 层被占时直接拒绝，把「等轮到我再开」的决定权留给插件
        if (current) {
            return {
                status: 'rejected',
                reason: 'occupied',
                occupant: { pluginId: current.pluginId, viewId: current.viewId },
            }
        }

        const found = (state.contributions.views as PluginViewContribution[] | undefined)?.find(
            (v) => v.pluginId === pluginId && v.id === viewId,
        )
        if (!found || !found.entryUrl) return { status: 'rejected', reason: 'unknown-view' }

        set({
            activeView: {
                pluginId,
                viewId,
                container: found.container,
                entryUrl: found.entryUrl,
                title: found.title,
                size: found.size,
                // 优先级：运行时 options > manifest 声明 > 默认 true
                escClose: options?.escClose ?? found.escClose,
                data: options?.data,
                openedAt: Date.now(),
            },
        })
        return { status: 'opened' }
    },

    closeView: (pluginId, viewId) => {
        const current = get().activeView
        if (!current) return false
        if (current.pluginId !== pluginId || current.viewId !== viewId) return false
        set({ activeView: null })
        return true
    },
}))
