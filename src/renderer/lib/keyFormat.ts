/**
 * 纯函数：electron 加速键 ↔ 库/显示格式转换
 */

// electron 修饰符 → tinykeys 修饰符
const MOD_TO_TINYKEYS: Record<string, string> = {
    CommandOrControl: '$mod',
    Control: 'Control',
    Meta: 'Meta',
    Alt: 'Alt',
    Shift: 'Shift',
}

// electron 特殊键名 → event.key/event.code 风格（字母/数字/Enter 等本就一致，无需映射）。
const KEY_TO_TINYKEYS: Record<string, string> = {
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Space: 'Space',
}

/** electron 加速键 → tinykeys 绑定串（event.key/code 风格）。空串返回空。 */
export function electronToTinykeys(accelerator: string): string {
    if (!accelerator) return ''
    return accelerator
        .split('+')
        .map((k) => {
            const t = k.trim()
            if (MOD_TO_TINYKEYS[t]) return MOD_TO_TINYKEYS[t]
            if (KEY_TO_TINYKEYS[t]) return KEY_TO_TINYKEYS[t]
            return t
        })
        .join('+')
}

/**
 * 归一化加速键用于「比较」：把平台无关修饰符 `CommandOrControl` 展开为当前平台实际修饰符
 * （Win / Linux → Control，Mac → Meta）。
 *
 * 用途：默认值存的是 `CommandOrControl+...`，而录入产出的是平台具体 `Control` / `Meta`，
 * 直接字符串比较会漏判跨面板重复（例：本地默认值 `CommandOrControl+Left` 与录入的 `Control+Left`
 * 在 Windows 上本就是同一键，却因字符串不等而查重失效）。归一化后两侧可比。
 */
export function normalizeAccelerator(accelerator: string): string {
    if (!accelerator) return ''
    const isMac = (window.env?.platform ?? 'win32') === 'darwin'
    const mod = isMac ? 'Meta' : 'Control'
    return accelerator
        .split('+')
        .map((k) => (k.trim() === 'CommandOrControl' ? mod : k.trim()))
        .join('+')
}

// ---------------------------------------------------------------------------
// 显示格式化（平台相关修饰符）
// ---------------------------------------------------------------------------

const DISPLAY_MODIFIERS = new Set(['CommandOrControl', 'Control', 'Meta', 'Alt', 'Shift'])

function displayModifier(t: string): string {
    const isMac = (window.env?.platform ?? 'win32') === 'darwin'
    switch (t) {
        case 'CommandOrControl':
            return isMac ? '⌘' : 'Ctrl'
        case 'Control':
            return 'Ctrl'
        case 'Meta':
            return isMac ? '⌘' : 'Win'
        case 'Alt':
            return isMac ? '⌥' : 'Alt'
        case 'Shift':
            return '⇧'
        default:
            return t
    }
}

const DISPLAY_KEYS: Record<string, string> = {
    Left: '←',
    Right: '→',
    Up: '↑',
    Down: '↓',
    Space: 'Space',
    Enter: '↵',
    Escape: 'Esc',
    Backspace: '⌫',
    Delete: '⌦',
    Tab: '⇥',
    CapsLock: '⇪',
}

/** electron 加速键 → 用户可读串（平台相关修饰符）。空串返回空。 */
export function formatHotkey(accelerator: string): string {
    if (!accelerator) return ''
    return accelerator
        .split('+')
        .map((k) => {
            const t = k.trim()
            if (DISPLAY_MODIFIERS.has(t)) return displayModifier(t)
            if (DISPLAY_KEYS[t]) return DISPLAY_KEYS[t]
            return t
        })
        .join('+')
}

// ---------------------------------------------------------------------------
// 录制态标志：录入快捷键时屏蔽应用内匹配，避免「录 Space 却触发播放」之类互殴。
// ---------------------------------------------------------------------------

let capturing = false

export function setHotkeyCapturing(value: boolean): void {
    capturing = value
}

export function isHotkeyCapturing(): boolean {
    return capturing
}
