import { create } from 'zustand'
import { isOk } from '@shared/result'
import { invokeResult } from '@renderer/lib/ipc'
import { rlog } from '@renderer/lib/log'

const INITIAL_STATE: UpdateState = {
    status: 'idle',
    currentVersion: '',
    latestVersion: null,
    error: null,
    progress: null,
}

/** 更新日志弹层的 UI 状态。拉取动作也放这里，关于页和 UpdateHost 共用同一份 */
interface ChangelogUI {
    open: boolean
    /** 拉取中。open 为 false 时也可能为 true —— 调用方据此给按钮做反馈 */
    loading: boolean
    /** 仅「用户主动请求且失败」时有值；首启静默失败不进这里 */
    error: string | null
    entries: ChangelogEntry[] | null
    /** 列表里哪一版是「当前运行的版本」（仅 inclusive 拉取时有值），用来打标记 */
    currentVersion: string | null
}

const CLOSED_CHANGELOG: ChangelogUI = {
    open: false,
    loading: false,
    error: null,
    entries: null,
    currentVersion: null,
}

interface OpenChangelogOptions {
    /** 失败时是否静默。首启（刚升级过）自动弹的那次传 true */
    silent?: boolean
    /** 是否把 fromVersion 自己那条也算进来 */
    inclusive?: boolean
}

interface UpdateStoreState {
    /** 状态机快照 */
    state: UpdateState
    /** 下载进度（~4Hz）。单独一个字段，订阅 state 的组件不会被它拖着重渲染 */
    progress: UpdateProgress | null
    /**
     * 本次启动前的版本号，由 main.tsx 对齐 application.version 时写入。
     * 非空 = 刚升级过；只在升级后的那一次启动有值（版本回退不算升级）。
     */
    previousVersion: string | null
    changelog: ChangelogUI
    setState: (next: UpdateState) => void
    setProgress: (next: UpdateProgress | null) => void
    setPreviousVersion: (version: string | null) => void
    /**
     * 打开更新日志并拉取版本说明。
     *
     * `fromVersion` 一般是「当前版本」：首启弹窗传升级前的版本（只看新增），
     * 手动「查看变更日志」传当前版本 + `inclusive`（连我这一版一起看）。
     */
    openChangelog: (fromVersion: string | null, options?: OpenChangelogOptions) => Promise<void>

    closeChangelog: () => void
}

export const useUpdateStore = create<UpdateStoreState>((set) => ({
    state: INITIAL_STATE,
    progress: null,
    previousVersion: null,
    changelog: CLOSED_CHANGELOG,

    setState: (next) => set({ state: next, progress: next.progress }),
    setProgress: (next) => set({ progress: next }),
    setPreviousVersion: (version) => set({ previousVersion: version }),

    openChangelog: async (fromVersion, { silent = false, inclusive = false } = {}) => {
        // 先不打开弹窗：拉取要一秒左右，且可能失败。失败时若弹窗已经开了，
        // 用户会看到「空弹窗闪一下然后消失」—— 这里只置 loading，让调用方的按钮去反馈。
        set({ changelog: { ...CLOSED_CHANGELOG, loading: true } })

        const r = await invokeResult<ChangelogEntry[]>('update:getChangelog', fromVersion, inclusive)
        if (isOk(r)) {
            set({
                changelog: {
                    open: true,
                    loading: false,
                    error: null,
                    entries: r.value,
                    currentVersion: inclusive ? fromVersion : null,
                },
            })
            return
        }

        // 首启自动弹的那次：拉不到就当没这回事，别在启动时糊用户一脸
        if (silent) {
            rlog.warn(`[update] 更新日志获取失败（首启静默）：${r.error}`)
            set({ changelog: CLOSED_CHANGELOG })
            return
        }

        // 用户主动点的：失败也要弹出来，否则就是「点了没反应」
        rlog.warn(`[update] 更新日志获取失败：${r.error}`)
        set({ changelog: { open: true, loading: false, error: r.error, entries: null, currentVersion: null } })
    },

    /** 只关不清理 */
    closeChangelog: () => set((s) => ({ changelog: { ...s.changelog, open: false } })),
}))
