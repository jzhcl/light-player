import { useMemo, type CSSProperties } from 'react'
import { buildDisplayLines } from '@renderer/features/lyrics/displayLines'
import { findLrcLineIndex } from '@renderer/features/lyrics/position'
import { useLyricChannel } from './useLyricChannel'
import { useLyricWindowStore } from './store'
import { useLyricInteraction } from './useLyricInteraction'
import { useResize } from './useResize'
import { Toolbar } from './components/Toolbar'
import { LyricView } from './components/LyricView'

/** 八个缩放方向。区做在窗口内部，几何见 ./styles.css 的 .rz-* */
const RESIZE_DIRECTIONS = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const

/**
 * 桌面歌词窗。
 *
 * 歌词数据全部来自主窗推送，外观（字体 / 字号 / 颜色 / 行数 / 对齐 / 翻译）
 * 来自「桌面歌词设置」—— 以 CSS 变量挂在窗口根上，行渲染见 components/LyricView。
 *
 * 整窗可拖：主进程把「按住左键移动」翻译成窗口位移（见 main/utils/draggable.ts）。
 * 这条路上用不了 `-webkit-app-region: drag` —— 它把区域划成非客户区，
 * hover 和内部按钮会一起失效。代价是工具栏得自己把拖拽让开，见 useDragGate。
 *
 * 鼠标穿透：指针离开窗口就整窗穿透、指针回到歌词行上再取消，见 useMouseThrough。
 * 缩放：区做在窗口内部（留了一圈 padding），不依赖系统边缘热区，见 useResize。
 */
export function App() {
    useLyricChannel()
    useResize()

    const song = useLyricWindowStore((s) => s.song)
    const parsed = useLyricWindowStore((s) => s.parsed)
    const timeMs = useLyricWindowStore((s) => s.timeMs)
    const playState = useLyricWindowStore((s) => s.playState)
    const settings = useLyricWindowStore((s) => s.settings)
    const { active, locked, toggleLock } = useLyricInteraction()

    // 显示行由产物压成；两个窗口用的是同一个纯函数，行结构必然同源
    const lines = useMemo(() => (parsed ? buildDisplayLines(parsed) : []), [parsed])
    const lineIndex = useMemo(() => findLrcLineIndex(lines, timeMs), [lines, timeMs])

    // 设置没到之前不注水
    const style = settings
        ? ({
              '--lyric-text': settings.colorPalette.played,
              '--lyric-text-dim': settings.colorPalette.unplayed,
              '--lyric-font-size': `${settings.font.size}px`,
              '--lyric-font-family': settings.font.family || undefined,
          } as CSSProperties)
        : undefined

    // 状态类由 useLyricInteraction 驱动：is-active 管底色/边界/工具栏一起亮，
    // is-locked 时底色恒不显（窗口只留一个解锁按钮浮着）
    const rootClass = ['lyric-window', active && 'is-active', locked && 'is-locked']
        .filter(Boolean)
        .join(' ')

    return (
        <div className={rootClass} style={style}>
            {/* 内容区单独一层：它才是「可交互的边界」——窗口比它大一圈，那圈让给了缩放区。
                底色与边框都画在这一层上，于是边界（边框）与可交互区天然重合。
                放在外层的话，边框永远画在 content box 之外，和底色对不齐。 */}
            <div className="lyric-panel">
                <LyricView
                    lines={lines}
                    lineIndex={lineIndex}
                    isPlaying={playState === 'playing'}
                    songName={song?.name ?? ''}
                />
            </div>

            {/* 缩放区锁定后不渲染；底色不可见时也不渲染 */}
            {!locked &&
                active &&
                RESIZE_DIRECTIONS.map((d) => (
                    <div key={d} className={`lyric-resize-zone rz-${d}`} data-resize={d}/>
                ))}

            <Toolbar playState={playState} locked={locked} onToggleLock={toggleLock} visible={active}/>
        </div>
    )
}
