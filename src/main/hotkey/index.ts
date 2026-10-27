import { BrowserWindow, globalShortcut } from 'electron'
import { LP_EVENT } from '@shared/event'

/**
 * 注册/更新一个全局快捷键：origin（旧键）→ target（新键）替换式注册。
 * - origin === target：无变化，直接成功。
 * - target 非空：先注册新键（已注册/被系统占用则抛错），成功后注销旧键。
 * - target 为空：仅注销旧键（清空快捷键）。
 * @throws 新键已被本应用注册，或已被系统/其他应用占用。
 */
export function registerShortcut(
    win: BrowserWindow,
    action: string,
    data: { origin: string; target: string },
): void {
    const { origin, target } = data

    if (origin === target) return

    if (target) {
        if (globalShortcut.isRegistered(target)) {
            throw new Error(`快捷键已被注册`)
        }
        const registered = globalShortcut.register(target, () => {
            if (!win.isDestroyed()) {
                win.webContents.send(LP_EVENT['HOTKEY_TRIGGERED'], action)
            }
        })
        if (!registered) {
            throw new Error(`快捷键已被系统或其他应用占用`)
        }
    }

    if (origin && globalShortcut.isRegistered(origin)) {
        globalShortcut.unregister(origin)
    }
}

/** 查询某加速键是否已被本应用注册（查询类，不抛错）。 */
export function isRegisteredShortcut(accelerator: string): boolean {
    if (!accelerator) return false
    return globalShortcut.isRegistered(accelerator)
}

/** 注销全部全局快捷键（含多媒体键）。 */
export function unregisterAllShortcut(): void {
    globalShortcut.unregisterAll()
}

const MEDIA_KEYS: Array<{ accelerator: string; action: string }> = [
    { accelerator: 'MediaPlayPause', action: 'togglePlay' },
    { accelerator: 'MediaNextTrack', action: 'next' },
    { accelerator: 'MediaPreviousTrack', action: 'previous' },
]

/**
 * 启用多媒体键（MediaPlayPause / MediaNextTrack / MediaPreviousTrack）。
 * 任一注册失败时回滚已注册的键并抛错 —— 「全成或全不成」，不留半开状态。
 * ⚠️ **不是幂等的**：已注册的键再注册会被 `globalShortcut.register` 判为「已被占用」→ 抛错。
 * 因此调用方不得靠重复调用来「确保生效」（要核对请用 `isMediaKeysRegistered`）。
 * @throws 多媒体键被系统或其他应用占用。
 */
export function enableMediaKeys(win: BrowserWindow): void {
    const registered: string[] = []
    try {
        for (const { accelerator, action } of MEDIA_KEYS) {
            const okRet = globalShortcut.register(accelerator, () => {
                if (!win.isDestroyed()) {
                    win.webContents.send(LP_EVENT['HOTKEY_TRIGGERED'], action)
                }
            })
            if (!okRet) {
                throw new Error(`多媒体键已被占用：${accelerator}`)
            }
            registered.push(accelerator)
        }
    } catch (err) {
        for (const acc of registered) {
            globalShortcut.unregister(acc)
        }
        throw err
    }
}

/** 注销多媒体键。 */
export function disableMediaKeys(): void {
    for (const { accelerator } of MEDIA_KEYS) {
        globalShortcut.unregister(accelerator)
    }
}

/** 多媒体键是否全部已注册 */
export function isMediaKeysRegistered(): boolean {
    return MEDIA_KEYS.every(({ accelerator }) => globalShortcut.isRegistered(accelerator))
}
