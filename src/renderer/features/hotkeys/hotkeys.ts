/**
 * 应用内 + 全局快捷键引擎
 *
 * 动作集合：本地 7 个（无 toggleWindowShow）、全局 6 个（含 toggleWindowShow）
 */
import { tinykeys, defaultKeybindingsHandlerIgnore } from 'tinykeys'
import { electronToTinykeys, isHotkeyCapturing } from '@renderer/lib/keyFormat'
import { useSettingsStore } from '@renderer/store'
import { player } from '@renderer/features/player/player'
import { invoke, invokeResult } from '@renderer/lib/ipc'
import { LP_EVENT } from '@shared/event'

type LocalHotkeyAction = keyof LP.RendererSetting['hotkey.local']
type GlobalHotkeyAction = keyof LP.RendererSetting['hotkey.global']
export type HotkeyAction = LocalHotkeyAction | GlobalHotkeyAction

/**
 * 单一动作分发。所有快捷键最终都汇到这里。
 * forward/rewind 已下沉到 player 层（默认 3 秒、自带夹取），直接调即可。
 */
function dispatchHotkeyAction(action: HotkeyAction): void {
    const settings = useSettingsStore.getState().settings
    switch (action) {
        case 'previous':
            void player.playPrev()
            break
        case 'next':
            void player.playNext()
            break
        case 'togglePlay':
            void player.togglePlay()
            break
        case 'volumeUp':
            player.setVolume(settings['player.audio.volume'] + 0.1)
            break
        case 'volumeDown':
            player.setVolume(settings['player.audio.volume'] - 0.1)
            break
        case 'forward':
            player.forward()
            break
        case 'rewind':
            player.rewind()
            break
        case 'toggleWindowShow':
            void invoke('mainWindow:toggleShow')
            break
    }
}

/**
 * tinykeys 的 `ignore` 谓词：复用库自带的输入框/contenteditable 屏蔽，叠加「正在录入快捷键」标志，
 * 否则在 HotkeyInput 里按 Space 录快捷键会同时触发播放。
 */
function shouldIgnore(event: KeyboardEvent): boolean {
    return isHotkeyCapturing() || defaultKeybindingsHandlerIgnore(event)
}

let unsubTinykeys: (() => void) | null = null

/** 按当前 `hotkey.local` 重建 tinykeys 绑定表（设置变更时调用）。 */
function rebuildLocalBindings(): void {
    const local = useSettingsStore.getState().settings['hotkey.local']
    const bindings: Record<string, (event: KeyboardEvent) => void> = {}
    for (const action of Object.keys(local) as LocalHotkeyAction[]) {
        const accelerator = local[action]
        if (!accelerator) continue
        const tinykey = electronToTinykeys(accelerator)
        if (!tinykey) continue
        bindings[tinykey] = (event) => {
            event.preventDefault()
            dispatchHotkeyAction(action)
        }
    }
    unsubTinykeys?.()
    unsubTinykeys = tinykeys(window, bindings, { ignore: shouldIgnore })
}

/** 启动恢复：按设置重新注册全部非空全局快捷键（仅当主开关开启）。 */
function registerGlobalFromSettings(): void {
    const { 'hotkey.global': global, 'hotkey.global.enable': enabled } =
        useSettingsStore.getState().settings
    if (!enabled) return
    for (const action of Object.keys(global) as GlobalHotkeyAction[]) {
        const accelerator = global[action]
        if (!accelerator) continue
        void invoke('hotkey:register', action, { origin: '', target: accelerator })
    }
}

/**
 * 应用多媒体键开关。
 *
 * ⚠️ 主进程的 `enableMediaKeys` 非幂等* —— 重复注册会被 `globalShortcut.register`
 * 判为「已被占用」而整组回滚报错。所以只有两种时机可以调它：
 *   ① 用户把开关从关注销切到开；
 *   ② 主进程 `hotkey:unregisterAll`（`globalShortcut.unregisterAll()`）把媒体键连带清掉后补回。
 * 其余情况（如页面挂载）一律不要调。
 *
 * @param enabled 目标状态
 * @returns 主进程 Result；调用方负责失败回滚与提示
 */
export function applyMediaKeys(enabled: boolean): Promise<Result<true>> {
    return invokeResult<true>(enabled ? 'hotkey:enableMediaKeys' : 'hotkey:disableMediaKeys')
}

/**
 * 注销全部全局快捷键（关闭「全局快捷键」总开关时调用）。
 *
 * 主进程 `hotkey:unregisterAll` = `globalShortcut.unregisterAll()`，而媒体键与全局快捷键
 * 共用同一个注册表 → 媒体键会被一并清掉。所以这里必须把开着的媒体键补注册回来，
 * 否则「关掉全局快捷键」会顺手废掉多媒体键，而设置里仍显示它开着。
 * （`enableMediaKeys` 非幂等，但此处刚被清空，正是可以安全重放的状态。）
 */
export async function unregisterAllGlobalShortcuts(): Promise<void> {
    await invoke('hotkey:unregisterAll')
    if (useSettingsStore.getState().settings['hotkey.mediaKeys.enable']) {
        await applyMediaKeys(true)
    }
}

/**
 * 初始化快捷键引擎。
 *  - 应用内：订阅 `hotkey.local`，变更即重建绑定。
 *  - 全局触发：监听主进程推送，分发到同一动作表。
 *  - 启动恢复：重新注册全局快捷键 + 多媒体键。
 */
export function initHotkeys(): void {
    rebuildLocalBindings()

    // 应用内：订阅 hotkey.local，变更即重建绑定。
    useSettingsStore.subscribe((state, prev) => {
        if (state.settings['hotkey.local'] !== prev.settings['hotkey.local']) {
            rebuildLocalBindings()
        }
    })

    // 全局触发：监听主进程推送。
    window.api.on(LP_EVENT['HOTKEY_TRIGGERED'], (action) => {
        dispatchHotkeyAction(action as HotkeyAction)
    })

    // 启动恢复：重新注册全局快捷键。
    registerGlobalFromSettings()

    // 启动恢复：多媒体键
    if (useSettingsStore.getState().settings['hotkey.mediaKeys.enable']) {
        void applyMediaKeys(true)
    }
}
