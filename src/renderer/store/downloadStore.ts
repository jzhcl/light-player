import { create } from 'zustand'


interface DownloadStoreState {
    /** 进行中任务数 */
    activeCount: number
    setActiveCount: (count: number) => void
}

export const useDownloadStore = create<DownloadStoreState>((set) => ({
    activeCount: 0,
    setActiveCount: (count: number) => {
        const next = count > 0 ? count : 0
        set({ activeCount: next })
    },
}))
