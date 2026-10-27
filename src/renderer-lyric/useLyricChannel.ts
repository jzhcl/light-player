import { useEffect } from 'react'
import { TOPIC } from '@shared/topic'
import type { DesktopLyricSettings, LyricSyncPayload } from '@renderer/features/desktopLyric/types'
import {
    resetKaraokeClock,
    setKaraokeClockRunning,
    syncKaraokeClock,
} from '@renderer/features/lyrics/karaokeClock'
import { useLyricWindowStore } from './store'

/**
 * 桌面歌词窗侧：订阅主窗推来的歌词整包 / 播放态 / 进度 / 外观设置。
 *
 * 顺带校准本窗口的逐字时钟。`karaokeClock` 是模块级单例，两个渲染窗各持一份、
 * 互不影响：主窗那份由 `engine` 校准，歌词窗这份只能在这里校准 ——
 * 少了它，逐字高亮会一直停在初始状态不动。
 */
export function useLyricChannel(): void {
    useEffect(() => {
        const { setSong, setPlayState, setTimeMs, setSettings } = useLyricWindowStore.getState()

        const off = window.api.subscribe(TOPIC.LYRIC, (channel, ...args) => {
            switch (channel) {
                case 'currentSongChanged': {
                    const payload = args[0] as LyricSyncPayload | undefined
                    const prevId = useLyricWindowStore.getState().parsed?.songId ?? null
                    const nextId = payload?.parsed?.songId ?? null

                    // 只有「两首不同的歌都拿到了产物」才算真换歌。
                    // 切歌瞬间推来的快照里 parsed 还是 null、歌词加载完会再推一次，
                    // 让 null 参与比较就会把同一轮切歌误判成两次，把已经在唱的逐字打断。
                    if (prevId && nextId && prevId !== nextId) resetKaraokeClock()

                    setSong(payload?.song ?? null, payload?.parsed ?? null)
                    break
                }
                case 'currentPlayStateChanged': {
                    const state = args[0] as PlayState
                    setPlayState(state)
                    // 暂停后主窗不再推 timeupdate，必须停住本地时钟，否则高亮会一直往前跑
                    setKaraokeClockRunning(state === 'playing')
                    break
                }
                case 'currentPlayTimeUpdated': {
                    const ms = args[0] as number
                    setTimeMs(ms)
                    syncKaraokeClock(ms)
                    break
                }
                case 'desktopLyricSettingChanged': {
                    const settings = args[0] as DesktopLyricSettings | undefined
                    if (settings) setSettings(settings)
                    break
                }
            }
        })

        // 订阅就位后再握手，主窗收到即回灌首帧快照
        window.api.publish(TOPIC.MAIN, 'message:lyricReady')

        return off
    }, [])
}
