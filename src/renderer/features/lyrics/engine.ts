import { useLyricsStore, usePlayerStore } from '@renderer/store'
import { isOk } from '@shared/result'
import { getSongLyric } from './songLyricService'
import { parseSongLyric } from './parse'
import { findKrcLineIndex, findLrcLineIndex } from './position'
import { resetKaraokeClock, setKaraokeClockRunning, syncKaraokeClock } from './karaokeClock'

/**
 * 歌词引擎。
 *
 * 只做两件事：切歌时加载并解析歌词；播放时按 currentTime 更新行级索引。
 * 逐字进度是 60fps 的高频量，由消费组件在自己的 rAF 里通过 karaokeClock 计算——
 * 引擎不持有任何定时器，没有歌词组件渲染时就没有额外计算。
 *
 * ⚠️ store 里的 `lineIndex` 是显示行索引，不等于 LRC 行索引：逐字歌词自带一排 KRC
 * 行，两边行数/时间都可能对不上（KRC 自带绝对时间，LRC 的 offset 不平移它），所以按当前
 * 模式算各自那套。消费方统一读 `displayLines[lineIndex]`，不必知道自己是哪种模式。
 *
 * 引擎只有一个挂载点（应用根），因此不需要引用计数。
 */

/** 已加载歌词的歌曲 id，用于避免同一首歌重复拉取 */
let loadedSongId: string | null = null
/** 上一次写入的时间，避免同一时刻重复计算 */
let prevTime = -1
let unsubscribe: (() => void) | null = null

async function loadLyric(song: LP.Song | null): Promise<void> {
    resetKaraokeClock()
    useLyricsStore.getState().reset()
    if (!song) return

    const r = await getSongLyric(song)
    if (!isOk(r)) return

    // 拉取是异步的，期间可能已经切歌——晚到的结果直接丢弃
    if (usePlayerStore.getState().currentSong?.id !== song.id) return

    useLyricsStore.getState().setParsed(parseSongLyric(r.value, song.id))
}

function syncTime(currentTimeSec: number): void {
    const ms = currentTimeSec * 1000

    // 逐字时钟校准
    syncKaraokeClock(ms)

    const { mode, lrcLines, krcLines, lineIndex } = useLyricsStore.getState()
    const next = mode === 'krc' ? findKrcLineIndex(krcLines, ms) : findLrcLineIndex(lrcLines, ms)
    if (next !== lineIndex) useLyricsStore.getState().setLineIndex(next)
}

/**
 * 启动引擎。返回停止函数，卸载时调用。
 */
export function initLyricEngine(): () => void {
    if (unsubscribe) return () => {}

    unsubscribe = usePlayerStore.subscribe((state) => {
        // 暂停后 timeupdate 不再到达，先停住本地时钟，否则逐字高亮会继续往前跑
        setKaraokeClockRunning(state.state === 'playing')

        const song = state.currentSong
        // 归一到 null 再比较
        const songId = song?.id ?? null
        if (songId !== loadedSongId) {
            loadedSongId = songId
            void loadLyric(song)
        }
        if (state.currentTime !== prevTime) {
            prevTime = state.currentTime
            syncTime(state.currentTime)
        }
    })

    return () => {
        unsubscribe?.()
        unsubscribe = null
        loadedSongId = null
        prevTime = -1
    }
}
