import { create } from 'zustand'

/**
 * 播放页浮层的显隐。
 *
 * 播放页是全屏浮层、不占路由，所以这里只是一个开关。不持久化——重启回到收起态。
 */
interface PlayOverlayState {
    visible: boolean
    open: () => void
    close: () => void
    toggle: () => void
}

export const usePlayOverlayStore = create<PlayOverlayState>((set) => ({
    visible: false,
    open: () => set({ visible: true }),
    close: () => set({ visible: false }),
    toggle: () => set((s) => ({ visible: !s.visible })),
}))
