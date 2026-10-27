import { useEffect, useState } from 'react'
import { formatHotkey, setHotkeyCapturing } from '@renderer/lib/keyFormat'

export interface HotkeyInputProps {
    value: string
    onChange: (value: string) => void
    disabled?: boolean
    /** 录入栏是否处于错误态（由外部判重/注册失败传入），用于显示红框。 */
    error?: boolean
    /** 场景增量类名（基础几何留在调用方的样式表里） */
    className?: string
}

const KEY_MAP: Record<string, string> = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Enter',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Tab: 'Tab',
}

const MODIFIER_KEYS = new Set(['Control', 'Meta', 'Alt', 'Shift'])

/** 由 KeyboardEvent 构造 Electron 加速键字符串，如 Control+Shift+Up。纯修饰键返回空串（忽略）。 */
function eventToAccelerator(e: KeyboardEvent): string {
    const mods: string[] = []
    if (e.ctrlKey) mods.push('Control')
    if (e.metaKey) mods.push('Meta')
    if (e.altKey) mods.push('Alt')
    if (e.shiftKey) mods.push('Shift')
    let key = e.key
    if (KEY_MAP[key]) key = KEY_MAP[key]
    else if (key.length === 1) key = key.toUpperCase()
    if (MODIFIER_KEYS.has(key)) return ''
    return [...mods, key].join('+')
}

// 快捷键录入控件：点击进入录制态，捕获下一次组合键；Esc 取消。
export function HotkeyInput({ value, onChange, disabled = false, error = false, className }: HotkeyInputProps) {
    const [recording, setRecording] = useState(false)

    useEffect(() => {
        if (!recording) return
        // 录入期间屏蔽应用内快捷键匹配，避免「录 Space 却触发播放」互殴。
        setHotkeyCapturing(true)
        const onKey = (e: KeyboardEvent) => {
            e.preventDefault()
            e.stopPropagation()
            if (e.key === 'Escape') {
                setRecording(false)
                return
            }
            // Backspace 视为「清除当前快捷键」，不录为组合键。
            if (e.key === 'Backspace') {
                onChange('')
                setRecording(false)
                return
            }
            const acc = eventToAccelerator(e)
            if (acc) {
                onChange(acc)
                setRecording(false)
            }
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
            window.removeEventListener('keydown', onKey, true)
            setHotkeyCapturing(false)
        }
    }, [recording, onChange])

    return (
        <button
            type="button"
            className={`hotkey-input${recording ? ' is-recording' : ''}${error ? ' is-error' : ''}${className ? ` ${className}` : ''}`}
            disabled={disabled}
            onClick={() => !disabled && setRecording(true)}
        >
            {recording ? '请按下快捷键…' : formatHotkey(value) || '点击设置'}
        </button>
    )
}
