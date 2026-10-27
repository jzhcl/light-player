import { invoke } from '@renderer/lib/ipc'

/**
 * 窗口控制：最小化 / 关闭
 */
export function useWindowControls() {
    const minimize = () => void invoke('mainWindow:minimize')
    const close = () => void invoke('mainWindow:close')

    return { minimize, close }
}
