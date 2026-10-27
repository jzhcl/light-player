import { useEffect } from 'react'
import { useLyricsStore, usePlayerStore, useSettingsStore, type ParsedLyric } from '@renderer/store'
import { LP_EVENT } from '@shared/event'
import { TOPIC } from '@shared/topic'
import { invoke } from '@renderer/lib/ipc'
import type { DesktopLyricSettings, LyricSyncPayload } from './types'

/**
 * 桌面歌词窗同步（主窗侧）。
 *
 * 门控：只在歌词窗「存在」时才推，
 * 开 / 关的唯一真相在主进程，这里只跟随 `DESKTOP_LYRIC.STATE` 广播。
 *
 * 首帧快照只有一条路：握手。 歌词窗关闭即销毁（见 main/windows.ts 的 openLyricWindow），
 * 每次打开都是全新页面，页面 mount 后自己发 `message:lyricReady`；
 * 这里收到就清掉全部去重位、回灌整包。
 *
 * 每条推送各带内容判据（见 pushSong / pushPlayState / pushTime），没变就不推。
 *
 * 外观设置（desktopLyric.*）跟着同一条门控走：歌词窗不可见时推过去没人消费。
 */

/**
 * 从 settingsStore 里摘出外观设置
 */
function readDesktopLyricSettings(): DesktopLyricSettings {
    const s = useSettingsStore.getState().settings
    return {
        lineCount: s['desktopLyric.lineCount'],
        align: s['desktopLyric.align'],
        secondaryLine: s['desktopLyric.secondaryLine'],
        font: s['desktopLyric.font'],
        colorPalette: s['desktopLyric.colorPalette'],
    }
}

export function useLyricSync(): void {
    useEffect(() => {
        /** 当前已注册的 watch 取消函数；空数组 = 未在同步。 */
        let unsubscribes: (() => void)[] = []

        // ---- 去重位。null / NaN 一律表示「尚未推过」 ----

        /** 上一次推出去的曲目 + 产物 */
        let pushedSong: { name: string | null; singer: string | null; parsed: ParsedLyric | null } | null = null
        /** 上一次推出去的播放态；`null` 不在 PlayState 取值域内，可当哨兵 */
        let pushedState: PlayState | null = null
        /** 上一次推出去的播放位置（毫秒）；NaN = 尚未推过 */
        let pushedTimeMs = Number.NaN
        /**
         * 上一次推出去的外观设置（序列化串）。设置是低频事件，但与歌词无关的设置
         * （音量、队列…）也会通知，靠它挡掉；空串 = 尚未推过。
         */
        let pushedSettings = ''

        /** 产物 memo：字段引用没变就复用上次那个对象 */
        let parsedMemo: { key: readonly unknown[]; value: ParsedLyric } | null = null

        /**
         * 从 lyricsStore 里摘出纯数据产物（memo 化）。
         */
        const readParsed = (): ParsedLyric | null => {
            const s = useLyricsStore.getState()
            // songId 必须与当前曲一致：切歌瞬间 lyricsStore 里可能还留着上一首的产物，
            // 直接发过去会变成「新曲名 + 旧歌词」。对不上就当作还没有产物。
            if (!s.songId || s.songId !== usePlayerStore.getState().currentSong?.id) return null

            const key = [
                s.songId,
                s.mode,
                s.lrcLines,
                s.metadata,
                s.krcLines,
                s.matchedTranslations,
                s.matchedRoma,
                s.karaToLrcLine,
                s.lrcToKaraLine,
                s.karaToLrcWord,
            ]
            const memo = parsedMemo
            if (memo && memo.key.every((v, i) => v === key[i])) return memo.value

            const value: ParsedLyric = {
                songId: s.songId,
                mode: s.mode,
                lrcLines: s.lrcLines,
                metadata: s.metadata,
                krcLines: s.krcLines,
                matchedTranslations: s.matchedTranslations,
                matchedRoma: s.matchedRoma,
                karaToLrcLine: s.karaToLrcLine,
                lrcToKaraLine: s.lrcToKaraLine,
                karaToLrcWord: s.karaToLrcWord,
            }
            parsedMemo = { key, value }
            return value
        }

        const push = (channel: string, ...args: unknown[]): void => {
            window.api.publish(TOPIC.LYRIC, channel, ...args)
        }

        const pushSong = (): void => {
            const song = usePlayerStore.getState().currentSong
            const parsed = readParsed()
            const name = song?.name ?? null
            const singer = song?.singer ?? null

            const prev = pushedSong
            if (prev && prev.name === name && prev.singer === singer && prev.parsed === parsed) return
            pushedSong = { name, singer, parsed }

            const payload: LyricSyncPayload = {
                song: song ? { name: song.name, singer: song.singer } : null,
                parsed,
            }
            push('currentSongChanged', payload)
        }

        const pushPlayState = (): void => {
            const state = usePlayerStore.getState().state
            if (state === pushedState) return
            pushedState = state
            push('currentPlayStateChanged', state)
        }

        const pushTime = (): void => {
            const ms = usePlayerStore.getState().currentTime * 1000
            if (ms === pushedTimeMs) return
            pushedTimeMs = ms
            push('currentPlayTimeUpdated', ms)
        }

        const pushSettings = (): void => {
            const payload = readDesktopLyricSettings()
            const key = JSON.stringify(payload)
            if (key === pushedSettings) return
            pushedSettings = key
            push('desktopLyricSettingChanged', payload)
        }

        /**
         * 回灌整包快照：曲目 + 产物 / 播放态 / 进度 / 外观设置。
         */
        const pushSnapshot = (): void => {
            pushSong()
            pushPlayState()
            pushTime()
            pushSettings()
        }

        const startSync = (): void => {
            if (unsubscribes.length) return // 幂等：已经在同步就不重复注册

            unsubscribes = [
                // 歌词产物就绪 / 清空（切歌时 loadLyric 先 reset 再 setParsed）
                useLyricsStore.subscribe((s, prev) => {
                    if (
                        s.songId !== prev.songId ||
                        s.mode !== prev.mode ||
                        s.lrcLines !== prev.lrcLines ||
                        s.krcLines !== prev.krcLines
                    ) {
                        pushSong()
                    }
                }),
                // 播放态 / 进度 / 曲目
                usePlayerStore.subscribe((s, prev) => {
                    if (s.state !== prev.state) pushPlayState()
                    if (s.currentTime !== prev.currentTime) pushTime()
                    // 曲目本身变了也要通知：歌词拉取失败时 lyricsStore 全程不变，
                    // 只看它就永远推不出「换歌了」→ 歌词窗的曲名兜底会滞留在上一首。
                    if (s.currentSong !== prev.currentSong) pushSong()
                }),
                // 外观设置：设置页改动即推（与歌词无关的设置变更由 pushSettings 自己去重）
                useSettingsStore.subscribe(() => pushSettings()),
            ]

            // 这里不灌首帧，首帧由 `message:lyricReady` 触发
        }

        const stopSync = (): void => {
            for (const un of unsubscribes) un()
            unsubscribes = []
        }

        // 门控驱动：只负责「开 / 关订阅」，首帧由握手灌
        const offState = window.api.on(LP_EVENT['DESKTOP_LYRIC.STATE'], (open) => {
            if (open === true) startSync()
            else stopSync()
        })

        // 歌词窗来的命令。播放控制（playPause / prev / next）不在这里处理：
        // 它们和托盘菜单用的是同一套 `control:*`，统一由 `useTraySync` 执行。
        const offCommand = window.api.subscribe(TOPIC.MAIN, (channel) => {
            switch (channel) {
                case 'control:closeDesktopLyricWindow':
                    void invoke('mainWindow:closeLyric')
                    break
                case 'message:lyricReady':
                    pushedSong = null
                    pushedState = null
                    pushedTimeMs = Number.NaN
                    pushedSettings = ''
                    parsedMemo = null
                    pushSnapshot()
                    break
            }
        })

        return () => {
            stopSync()
            offState()
            offCommand()
        }
    }, [])
}
