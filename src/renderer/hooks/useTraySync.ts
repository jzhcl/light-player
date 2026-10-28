import { useEffect } from 'react'
import { isOk } from '@shared/result'
import { TOPIC } from '@shared/topic'
import { invoke } from '@renderer/lib/ipc'
import { NEXT_MODE, player } from '@renderer/features/player/player'
import { markSongLike, unmarkSongLike } from '@renderer/features/song/songLike'
import { usePlayerStore } from '@renderer/store/playerStore'
import { useSettingsStore } from '@renderer/store/settingsStore'

/** 上报给托盘的载荷 */
interface TrayPayload {
    isPlaying: boolean
    songTitle: string
    singer: string
    isLiked: boolean
    playMode: PlayMode
    volume: number
}

/**
 * 构造上报载荷
 */
function readPayload(): TrayPayload {
    const s = usePlayerStore.getState()
    const song = s.currentSong
    const settings = useSettingsStore.getState().settings
    return {
        isPlaying: s.state === 'playing',
        songTitle: song?.name ?? '',
        singer: song?.singer ?? '',
        isLiked: song?.isLiked === true,
        playMode: settings['player.mode'],
        volume: settings['player.audio.volume'],
    }
}

/** 切换当前歌曲的喜欢状态（托盘菜单入口，不依赖底栏组件是否挂着监听） */
async function toggleCurrentSongLike(): Promise<void> {
    const song = usePlayerStore.getState().currentSong
    if (!song) return

    const nextLiked = !song.isLiked
    const result = nextLiked ? await markSongLike(song.id) : await unmarkSongLike(song.id)
    if (!isOk(result)) return

    const current = usePlayerStore.getState().currentSong
    if (current?.id === song.id) {
        usePlayerStore.setState({ currentSong: { ...current, isLiked: nextLiked } })
    }
}

/** 托盘状态同步 + 托盘命令执行 */
export function useTraySync(): void {
    // ---- 播放状态 / 当前曲 / 音量 / 播放模式 → 上报 ----
    useEffect(() => {
        let timer: number | null = null

        const report = (): void => {
            void invoke('tray:updateState', readPayload())
        }

        // 防抖：连续变更只在安静下来后上报一次最终状态。
        const scheduleReport = (): void => {
            if (timer !== null) window.clearTimeout(timer)
            timer = window.setTimeout(() => {
                timer = null
                report()
            }, 20)
        }

        // 首次挂载立即同步一次，避免启动后托盘一直停在「暂无播放」
        report()

        const unsubPlayer = usePlayerStore.subscribe((s, prev) => {
            if (s.state !== prev.state || s.currentSong !== prev.currentSong) scheduleReport()
        })
        const unsubSettings = useSettingsStore.subscribe((s, prev) => {
            if (
                s.settings['player.audio.volume'] !== prev.settings['player.audio.volume'] ||
                s.settings['player.mode'] !== prev.settings['player.mode']
            ) {
                scheduleReport()
            }
        })

        return () => {
            // 卸载时把待发的上报立刻补上，避免丢掉最后一次状态变更
            if (timer !== null) {
                window.clearTimeout(timer)
                timer = null
                report()
            }
            unsubPlayer()
            unsubSettings()
        }
    }, [])

    // ---- 托盘菜单的控制命令 → 执行 ----
    useEffect(() => {
        return window.api.subscribe(TOPIC.MAIN, (channel, ...args) => {
            switch (channel) {
                case 'control:playPause':
                    void player.togglePlay()
                    break
                case 'control:previous':
                    void player.playPrev()
                    break
                case 'control:next':
                    void player.playNext()
                    break
                case 'control:toggleLike':
                    void toggleCurrentSongLike()
                    break
                case 'control:cyclePlayMode': {
                    const mode = useSettingsStore.getState().settings['player.mode']
                    player.setMode(NEXT_MODE[mode])
                    break
                }
                case 'control:setVolume':
                    if (typeof args[0] === 'number') player.setVolume(args[0])
                    break
                case 'control:toggleDesktopLyricWindow':
                    // 歌词窗开关的结果只有主进程知道，这里不复读状态
                    void invoke('mainWindow:toggleLyric')
                    break
            }
        })
    }, [])
}
