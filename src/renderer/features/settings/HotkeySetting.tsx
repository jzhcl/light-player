import { useEffect, useState } from 'react'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { HotkeyInput } from '@renderer/components/ui/HotkeyInput'
import { useSettingsStore, getDefaultRendererSettings } from '@renderer/store'
import { normalizeAccelerator } from '@renderer/lib/keyFormat'
import { invoke, invokeResult } from '@renderer/lib/ipc'
import { isOk } from '@shared/result'
import { unregisterAllGlobalShortcuts } from '@renderer/features/hotkeys/hotkeys'

type HotkeyAction =
    | 'previous'
    | 'next'
    | 'volumeUp'
    | 'volumeDown'
    | 'forward'
    | 'rewind'
    | 'togglePlay'
    | 'toggleWindowShow'

type GlobalAction = Exclude<HotkeyAction, 'forward' | 'rewind'>

const LOCAL_LABELS: Record<Exclude<HotkeyAction, 'toggleWindowShow'>, string> = {
    previous: '上一首',
    next: '下一首',
    volumeUp: '音量 +',
    volumeDown: '音量 -',
    forward: '快进',
    rewind: '快退',
    togglePlay: '播放 / 暂停',
}

const GLOBAL_LABELS: Record<GlobalAction, string> = {
    previous: '上一首',
    next: '下一首',
    volumeUp: '音量 +',
    volumeDown: '音量 -',
    togglePlay: '播放 / 暂停',
    toggleWindowShow: '显示 / 隐藏窗口',
}

const LOCAL_ACTIONS = Object.keys(LOCAL_LABELS) as Array<Exclude<HotkeyAction, 'toggleWindowShow'>>
const GLOBAL_ACTIONS = Object.keys(GLOBAL_LABELS) as GlobalAction[]

type Scope = 'local' | 'global'

/**
 * 查重：找出与给定加速键冲突的动作。返回冲突动作名 + 其所在面板，无冲突返回 null。
 * 仅对非空加速键检查；v 为空（清除）恒不冲突。
 */
function findDuplicate(
    acc: string,
    current: HotkeyAction,
    scope: Scope,
    local: Record<string, string>,
    global: Record<string, string>,
): { label: string; otherScope: Scope } | null {
    if (!acc) return null
    // 归一化比较：默认值存 `CommandOrControl+...`，录入产出 `Control`/`Meta`，直接比会漏判跨面板重复。
    const a = normalizeAccelerator(acc)
    const cross = (scope === 'local' ? Object.entries(global) : Object.entries(local)) as Array<[string, string]>
    const crossLabels = (scope === 'local' ? GLOBAL_LABELS : LOCAL_LABELS) as Record<string, string>
    for (const [k, v] of cross) {
        if (normalizeAccelerator(v) === a) {
            return { label: crossLabels[k] ?? k, otherScope: scope === 'local' ? 'global' : 'local' }
        }
    }
    const same = (scope === 'local' ? Object.entries(local) : Object.entries(global)) as Array<[string, string]>
    const sameLabels = (scope === 'local' ? LOCAL_LABELS : GLOBAL_LABELS) as Record<string, string>
    for (const [k, v] of same) {
        if (k !== current && normalizeAccelerator(v) === a) {
            return { label: sameLabels[k] ?? k, otherScope: scope }
        }
    }
    return null
}

/** 由查重结果构造用户可读文案：跨面板标明对方面板（应用内/全局），同面板只给动作名。 */
function duplicateMessage(dup: { label: string; otherScope: Scope }, scope: Scope): string {
    if (dup.otherScope !== scope) {
        const where = dup.otherScope === 'global' ? '全局' : '应用内'
        return `快捷键与${where}的「${dup.label}」重复`
    }
    return `快捷键与「${dup.label}」重复`
}

// 快捷键设置页：
//  - 全局快捷键：编辑即时经 hotkey:register 运行时注册（真正生效）；主开关控制批量注册/注销。
//  - 本地快捷键：写入设置（hotkey.local），供渲染端按键监听接管。
//  - 每项各有一个「重置」：还原该项默认加速键，且复用与「录入」完全相同的更新路径
//    （本地照常查重、全局照常注册）→ 冲突/被占用时同样标红且不写入。全局开关不参与重置。
export function HotkeySetting() {
    const local = useSettingsStore((s) => s.settings['hotkey.local'])
    const global = useSettingsStore((s) => s.settings['hotkey.global'])
    const globalEnabled = useSettingsStore((s) => s.settings['hotkey.global.enable'])
    const setSetting = useSettingsStore((s) => s.setSetting)

    const defaultLocal = getDefaultRendererSettings()['hotkey.local']
    const defaultGlobal = getDefaultRendererSettings()['hotkey.global']

    // 录入栏内联错误：key = `local.${action}` / `global.${action}`。
    // 一律显示在录入栏下方。
    const [errors, setErrors] = useState<Record<string, string>>({})
    const setError = (key: string, msg: string) => setErrors((p) => ({ ...p, [key]: msg }))
    const clearError = (key: string) =>
        setErrors((p) => {
            if (!(key in p)) return p
            const n = { ...p }
            delete n[key]
            return n
        })

    const updateLocal = (action: Exclude<HotkeyAction, 'toggleWindowShow'>, v: string) => {
        const key = `local.${action}`
        if (v && v !== local[action]) {
            const dup = findDuplicate(v, action, 'local', local, global)
            if (dup) {
                setError(key, duplicateMessage(dup, 'local'))
                return
            }
        }
        clearError(key)
        setSetting('hotkey.local', { ...local, [action]: v })
    }

    const updateGlobal = async (action: GlobalAction, v: string) => {
        const key = `global.${action}`
        const origin = global[action] ?? ''
        if (v && v !== origin) {
            const dup = findDuplicate(v, action, 'global', local, global)
            if (dup) {
                setError(key, duplicateMessage(dup, 'global'))
                return
            }
        }
        if (!globalEnabled || v === origin) {
            clearError(key)
            setSetting('hotkey.global', { ...global, [action]: v })
            return
        }
        // 启用且变化：先注册，成功才写入并清错；失败只标红、不写入（录入栏回退显示旧键，与老项目一致）。
        const r = await invokeResult<true>('hotkey:register', action, { origin, target: v })
        if (!isOk(r)) {
            setError(key, r.error)
            return
        }
        clearError(key)
        setSetting('hotkey.global', { ...global, [action]: v })
    }

    const toggleGlobal = async (enabled: boolean) => {
        setSetting('hotkey.global.enable', enabled)
        // 切换开关即清全局错误，随后按需重注册。
        for (const a of GLOBAL_ACTIONS) clearError(`global.${a}`)
        if (!enabled) {
            // 注销全部全局键；其中被连带清掉的媒体键由该函数按设置补回
            await unregisterAllGlobalShortcuts()
            return
        }
        // 单个失败只在该栏标红
        for (const action of GLOBAL_ACTIONS) {
            const v = global[action]
            if (!v) continue
            const r = await invokeResult<true>('hotkey:register', action, { origin: '', target: v })
            if (!isOk(r)) setError(`global.${action}`, r.error)
        }
    }

    // 页面挂载即核对全局快捷键的真实注册情况：
    // 启动期若某键被占用而注册失败，这里第一时间在该栏标红；已注册的清错。仅挂载检查一次。
    useEffect(() => {
        if (!globalEnabled) return
        void (async () => {
            for (const action of GLOBAL_ACTIONS) {
                const v = global[action]
                if (!v) continue
                const registered = await invoke<boolean>('hotkey:isRegistered', v)
                if (registered) {
                    clearError(`global.${action}`)
                    continue
                }
                const r = await invokeResult<true>('hotkey:register', action, { origin: '', target: v })
                if (!isOk(r)) setError(`global.${action}`, r.error)
                else clearError(`global.${action}`)
            }
        })()
    }, [])

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">本地快捷键</h2>
                </header>
                <div className="settings-group-body">
                    {LOCAL_ACTIONS.map((action) => (
                        <div className="settings-item" key={action}>
                            <div className="settings-item-label">
                                <span className="settings-item-name">{LOCAL_LABELS[action]}</span>
                            </div>
                            <div className="settings-item-action hotkey-action-col">
                                <div className="hotkey-row">
                                    <HotkeyInput
                                        className="settings-input"
                                        value={local[action]}
                                        onChange={(v) => updateLocal(action, v)}
                                    />
                                    <button
                                        type="button"
                                        className="settings-btn settings-btn--sm"
                                        disabled={
                                            normalizeAccelerator(local[action]) ===
                                            normalizeAccelerator(defaultLocal[action])
                                        }
                                        onClick={() => updateLocal(action, defaultLocal[action])}
                                    >
                                        重置
                                    </button>
                                </div>
                                {errors[`local.${action}`] && (
                                    <span className="settings-item-error">{errors[`local.${action}`]}</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">全局快捷键</h2>
                    <div className="settings-group-header-action">
                        <Checkbox checked={globalEnabled} onChange={toggleGlobal} ariaLabel="启用全局快捷键" />
                    </div>
                </header>
                <div className="settings-group-body">
                    {GLOBAL_ACTIONS.map((action) => (
                        <div className="settings-item" key={action}>
                            <div className="settings-item-label">
                                <span className="settings-item-name">{GLOBAL_LABELS[action]}</span>
                            </div>
                            <div className="settings-item-action hotkey-action-col">
                                <div className="hotkey-row">
                                    <HotkeyInput
                                        className="settings-input"
                                        value={global[action]}
                                        disabled={!globalEnabled}
                                        error={!!errors[`global.${action}`]}
                                        onChange={(v) => void updateGlobal(action, v)}
                                    />
                                    <button
                                        type="button"
                                        className="settings-btn settings-btn--sm"
                                        disabled={
                                            normalizeAccelerator(global[action]) ===
                                            normalizeAccelerator(defaultGlobal[action])
                                        }
                                        onClick={() => void updateGlobal(action, defaultGlobal[action])}
                                    >
                                        重置
                                    </button>
                                </div>
                                {errors[`global.${action}`] && (
                                    <span className="settings-item-error">{errors[`global.${action}`]}</span>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </>
    )
}
