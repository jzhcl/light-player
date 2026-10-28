import {
    memo,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
} from 'react'
import { isOk } from '@shared/result'
import {
    closestCenter,
    DndContext,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type PointerSensorOptions,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'

/** PointerSensor 选项 */
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 5 } }
import * as CtxMenu from '@radix-ui/react-context-menu'
import { formatPlayTime } from '@shared/format'
import { ContextMenu } from '@renderer/components/ContextMenu'
import { Icon } from '@renderer/components/Icon'
import { Cover } from '@renderer/components/ui/Cover'
import { Popover } from '@renderer/components/ui/Popover'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { player } from '@renderer/features/player/player'
import { addSongToPlaylist } from '@renderer/features/playlist/playlistService'
import { AddToSubMenu } from '@renderer/features/song/songMenu'
import { isQueueRef, type QueueEntry } from '@renderer/features/song/songKey'
import { ensureSong } from '@renderer/features/song/songIngest'
import { markSongLike } from '@renderer/features/song/songLike'
import { DRAG_REORDER_MAX } from '@renderer/lib/constants'
import { getSongById } from '@renderer/lib/db'
import { isBlurDismiss } from '@renderer/lib/overlay'
import { usePlaylistStore, useQueueStore } from '@renderer/store'
import { useQueueView, type QueueRow } from './useQueueView'
import { useQueueWindow } from './useQueueWindow'

/**
 * 播放队列浮层。
 *
 * 形态：挂在底栏右侧队列按钮上的 Popover（side=top），无全屏遮罩。
 *
 * 行的骨架：`[序号/波形/拖动柄] [封面] [歌名 + 歌手] [时长] [移除]`。
 * 左槽常态是序号（当前曲显示波形），悬停时整体让位给拖动柄。
 *
 * 1. 行组件必须 memo：父组件订阅 `currentIndex`，不 memo 的话切一次歌就是全表重渲。
 * 2. 超闸门不挂 sortable。
 * 3. 渐进渲染与拖拽互斥：渐进时未渲染的行没有 droppable，拖拽跨不过去。
 */

/** `useSortable` 的 listeners 类型，从实现反推 —— 顶层入口没导出 `SyntheticListenerMap` */
type SortableListeners = ReturnType<typeof useSortable>['listeners']

interface TrackProps {
    row: QueueRow
    index: number
    isCurrent: boolean
    onPlay: (index: number) => void
    onRemove: (index: number) => void
}

interface TrackBodyProps extends TrackProps {
    /** 能不能拖：false 时不出拖动柄，也不接 droppable 的 ref */
    draggable: boolean
    setNodeRef?: (el: HTMLDivElement | null) => void
    listeners?: SortableListeners
    /** 只取 y：列表是纵向的 */
    transformY?: number
    transition?: string
    isDragging?: boolean
}

/**
 * 行的 DOM ：拖不拖只是外面套不套 `useSortable`，行内结构与样式不复制第二遍。
 */
function QueueTrackBody({
    row,
    index,
    isCurrent,
    onPlay,
    onRemove,
    draggable,
    setNodeRef,
    listeners,
    transformY,
    transition,
    isDragging,
}: TrackBodyProps) {
    const { song, missing } = row

    return (
        <div
            ref={setNodeRef}
            data-queue-index={index}
            className={[
                'queue-track',
                isCurrent ? 'is-current' : '',
                isDragging ? 'is-dragging' : '',
                missing ? 'is-missing' : '',
            ]
                .filter(Boolean)
                .join(' ')}
            style={
                transformY === undefined
                    ? undefined
                    : { transform: `translate3d(0px, ${transformY}px, 0)`, transition }
            }
            title={song ? `${song.name} - ${song.singer}` : '歌曲已不可用'}
            onDoubleClick={() => {
                if (song) onPlay(index)
            }}
        >
            <span className="queue-slot">
                {isCurrent ? (
                    <span className="wave" aria-hidden="true">
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                        <span className="wave-bar"/>
                    </span>
                ) : (
                    <span className="queue-index">{index + 1}</span>
                )}
                {draggable ? (
                    <button
                        className="queue-handle"
                        type="button"
                        tabIndex={-1}
                        title="拖动调整顺序"
                        {...listeners}
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                    >
                        <Icon name="arrow-down-up" size={12}/>
                    </button>
                ) : null}
            </span>

            <Cover pic={song?.pic} className="queue-cover" lazy/>

            <span className="queue-info">
                <span className="queue-name ellipsis">
                    {song?.name ?? (missing ? '歌曲已不可用' : '加载中…')}
                </span>
                <span className="queue-singer ellipsis">{song?.singer || '未知艺术家'}</span>
            </span>

            <span className="queue-duration">{song ? formatPlayTime(song.duration) : '--:--'}</span>

            <button
                className="queue-remove"
                type="button"
                title="从队列中移除"
                onClick={(e) => {
                    e.stopPropagation()
                    onRemove(index)
                }}
                onDoubleClick={(e) => e.stopPropagation()}
            >
                <Icon name="x" size={12}/>
            </button>
        </div>
    )
}

function SortableQueueTrackImpl(props: TrackProps) {
    const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.row.key })
    return (
        <QueueTrackBody
            {...props}
            draggable
            setNodeRef={setNodeRef}
            listeners={listeners}
            transformY={transform?.y}
            transition={transition}
            isDragging={isDragging}
        />
    )
}

function QueueTrackImpl(props: TrackProps) {
    return <QueueTrackBody {...props} draggable={false}/>
}

/**
 * 两种挂法各自 memo：切歌时只有「上一首 / 当前曲」两行 props 变化，其余直接 bailout。
 * 三个前提缺一不可：`row` 身份在切歌时稳定（`useQueueView` 的 useMemo 依赖 queue/cache/missing，
 * 切歌都不变）、`onPlay` / `onRemove` 是 useCallback、`index` 只在下标真变时才变。
 */
const SortableQueueTrack = memo(SortableQueueTrackImpl)
const QueueTrack = memo(QueueTrackImpl)

export function QueuePanel() {
    const queue = useQueueStore((s) => s.queue) as QueueEntry[]
    const currentIndex = useQueueStore((s) => s.currentIndex)
    const playlists = usePlaylistStore((s) => s.playlists)

    const [open, setOpen] = useState(false)
    const [menuIndex, setMenuIndex] = useState(-1)
    const anchorRef = useRef<HTMLButtonElement | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    // 受控回调与 document 级监听必须在事件当下读到最新值，等不到 state 提交
    const menuIndexRef = useRef(-1)
    const pendingRef = useRef(-1)

    // 面板关着也照喂真队列：行数组随开关变空会让退场动画那几帧闪成空态。
    // 查不查库由第二个参数管，看不见的面板不发查询。
    const rows = useQueueView(queue, open)
    // 回调要读「最新一批行」，但不该让行数组的身份进依赖 —— 每次解析回填都会换一次身份
    const rowsRef = useRef(rows)
    rowsRef.current = rows

    const keys = useMemo(() => rows.map((row) => row.key), [rows])

    /** 超闸门就不挂 dnd-kit */
    const sortableEnabled = queue.length <= DRAG_REORDER_MAX

    /**
     * 渐进窗口。与拖拽互斥。面板关着时不补齐。
     */
    const win = useQueueWindow(queue.length, currentIndex, {
        progressive: !sortableEnabled,
        active: open,
    })

    const visibleRows = useMemo(
        () => rows.slice(win.from, win.from + win.count),
        [rows, win.from, win.count],
    )

    const TrackComponent = sortableEnabled ? SortableQueueTrack : QueueTrack

    const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS))

    // 队列整体换掉时（换歌单播放等），菜单指向的行可能已不存在
    useEffect(() => {
        menuIndexRef.current = -1
        setMenuIndex(-1)
    }, [queue])

    /**
     * 打开面板时把当前曲滚进视野；已完整可见就不动，免得每次切歌都晃一下。
     *
     * 必须等面板真正布局完再滚：面板是这一帧刚插进 DOM 的，effect 当下读
     * `offsetTop / clientHeight` 拿到的是「未布局」的值。
     * 所以推迟到 rAF，并在拿到可信尺寸前重试几帧。
     *
     * 重试上限给到 ~1s：渐进窗口初期可能还没覆盖到当前曲（切歌切到窗口外时，
     * `useQueueWindow` 要先扩窗、下一帧才渲染出那一行），要留出等它出现的余量。
     */
    useEffect(() => {
        if (!open || currentIndex < 0) return
        let raf = 0
        let tries = 0
        const step = () => {
            const el = scrollRef.current
            const rowEl = el?.querySelector<HTMLElement>(`[data-queue-index="${currentIndex}"]`)
            // 尺寸还没量到（面板刚挂载 / 该行还没渲染出来）→ 下一帧再看
            const notReady = !el || !rowEl || el.clientHeight === 0 || rowEl.offsetHeight === 0
            if (notReady) {
                if (tries++ < 60) raf = requestAnimationFrame(step)
                return
            }
            const top = rowEl.offsetTop
            if (top >= el.scrollTop && top + rowEl.offsetHeight <= el.scrollTop + el.clientHeight) return
            el.scrollTo({
                top: Math.max(0, top - (el.clientHeight - rowEl.offsetHeight) / 2),
                behavior: 'smooth',
            })
        }
        raf = requestAnimationFrame(step)
        return () => cancelAnimationFrame(raf)
    }, [open, currentIndex])

    const playFrom = useCallback((index: number) => {
        void player.switchTo(index).then(() => player.play())
    }, [])

    const removeAt = useCallback((index: number) => {
        const row = rowsRef.current[index]
        if (!row) return
        player.removeFromQueue(row.entry)
    }, [])

    const handleDragEnd = useCallback((e: DragEndEvent) => {
        const { active, over } = e
        if (!over || active.id === over.id) return
        const list = rowsRef.current
        const from = list.findIndex((row) => row.key === String(active.id))
        const to = list.findIndex((row) => row.key === String(over.id))
        if (from === -1 || to === -1) return
        player.reorderQueue(arrayMove(list.map((row) => row.key), from, to))
    }, [])

    /** 队列项 → 可写库的 LP.Song（未落库的插件项先落库）。菜单里需要 songs.id 的动作都走它 */
    const resolveSong = useCallback(async (row: QueueRow): Promise<LP.Song | null> => {
        if (isQueueRef(row.entry)) {
            const r = await getSongById(row.entry.id)
            if (!isOk(r)) {
                return null
            }
            if (!r.value) {
                return null
            }
            return r.value
        }
        const r = await ensureSong(row.entry)
        if (!isOk(r)) {
            return null
        }
        return r.value
    }, [])

    const likeRow = useCallback(
        async (row: QueueRow) => {
            const song = await resolveSong(row)
            if (!song) return
            // 已喜欢需预筛跳过：否则 markSongLike 重复写库、重复 emit，
            // 并把该曲反复顶到 liked 歌单首位。
            if (song.isLiked) {
                return
            }
            const r = await markSongLike(song.id)
            if (!isOk(r)) {
                return
            }
        },
        [resolveSong],
    )

    const addRowToPlaylist = useCallback(
        async (row: QueueRow, playlistId: string, _label: string) => {
            const song = await resolveSong(row)
            if (!song) return
            const out = { inserted: false }
            const r = await addSongToPlaylist(playlistId, song.id, undefined, out)
            if (!isOk(r)) {
                return
            }

        },
        [resolveSong],
    )

    /**
     * 命中检测：挂在面板根上、冒泡阶段用 closest 找被右键的那一行。
     *
     * 必须早于 Radix Trigger 自己的 onContextMenu —— 二者是同一元素上被组合的两个 handler，
     * 我们排在前面；这样 pendingRef 已就位，Radix 触发打开时才知道要开哪一行。
     */
    const handleContextMenu = useCallback((e: ReactMouseEvent<HTMLDivElement>) => {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-queue-index]')
        const index = el ? Number(el.dataset.queueIndex) : NaN
        const valid =
            el !== null && Number.isInteger(index) && index >= 0 && index < rowsRef.current.length
        pendingRef.current = valid ? index : -1
        // 菜单已开着又右键了另一行：受控 open 值没变，Radix 不会回调 onOpenChange，
        // 必须自己换行，否则菜单会停在上一行
        if (valid && menuIndexRef.current >= 0) {
            menuIndexRef.current = index
            setMenuIndex(index)
        }
    }, [])

    const setMenuOpen = useCallback((index: number) => {
        menuIndexRef.current = index
        setMenuIndex(index)
    }, [])

    const menuRow = menuIndex >= 0 && menuIndex < rows.length ? rows[menuIndex] : undefined

    const renderMenu = useCallback(
        (row: QueueRow, index: number): ReactNode => (
            <>
                <ContextMenu.Item icon="play" disabled={row.missing} onSelect={() => playFrom(index)}>
                    播放
                </ContextMenu.Item>
                <ContextMenu.Item icon="x" onSelect={() => removeAt(index)}>
                    从队列中移除
                </ContextMenu.Item>
                <ContextMenu.Separator/>
                <AddToSubMenu
                    playlists={playlists}
                    includeLiked
                    onPickLiked={() => void likeRow(row)}
                    onPickPlaylist={(p) => void addRowToPlaylist(row, p.id, p.name)}
                />
            </>
        ),
        [playlists, playFrom, removeAt, likeRow, addRowToPlaylist],
    )

    const body =
        rows.length === 0 ? (
            <div className="queue-empty center">
                <Icon name="music-note-list" size={36} className="queue-empty-icon"/>
                <p className="queue-empty-text">播放队列为空</p>
                <p className="queue-empty-hint">从歌曲列表中添加歌曲开始播放</p>
            </div>
        ) : (
            <ScrollArea
                className="queue-scroll"
                scrollClassName="queue-scroll-view"
                thumbClassName="queue-scroll-thumb"
                trigger="hover"
                autoHide
                deps={[rows, win.from, win.count]}
                scrollRef={scrollRef}
            >
                <div className="queue-list">
                    {visibleRows.map((row, i) => {
                        const index = win.from + i
                        return (
                            <TrackComponent
                                key={row.key}
                                row={row}
                                index={index}
                                isCurrent={index === currentIndex}
                                onPlay={playFrom}
                                onRemove={removeAt}
                            />
                        )
                    })}
                </div>
            </ScrollArea>
        )

    return (
        <Popover
            // 懒挂载 + 常驻
            keepMounted
            open={open}
            onOpenChange={(next) => {
                // 菜单开着时的「关闭」请求来自点菜单项 —— 那是菜单自己的收尾，不是要收面板。
                // 不拦这一下，面板会在菜单项的动作生效前就消失。
                if (!next && menuIndexRef.current >= 0) return
                setOpen(next)
            }}
            side="top"
            align="end"
            sideOffset={10}
            anchorRef={anchorRef}
            className="queue-popover popover--bare"
            arrow={false}
            anchor={
                <button
                    ref={anchorRef}
                    className={`control-button${open ? ' is-active' : ''}`}
                    type="button"
                    title="播放队列"
                    aria-label="播放队列"
                    aria-haspopup="true"
                    aria-expanded={open}
                    onClick={() => setOpen((v) => !v)}
                >
                    <Icon name="music-note-list" size={16}/>
                </button>
            }
        >
            <CtxMenu.Root
                // 受控显隐
                open={menuRow !== undefined}
                // 不铺全局遮罩
                modal={false}
                onOpenChange={(next) => {
                    if (next) {
                        // 锚点位置已由 Radix Trigger 按指针坐标记好，这里只决定「开哪一行」
                        const hit = pendingRef.current
                        pendingRef.current = -1
                        // 空白处右键：Radix 已把 open 推成 true，但我们不接管 → 菜单不开
                        if (hit >= 0) setMenuOpen(hit)
                        return
                    }
                    if (isBlurDismiss()) return
                    setMenuOpen(-1)
                }}
            >
                <CtxMenu.Trigger asChild>
                    <div className="queue-panel" onContextMenu={handleContextMenu}>
                        <div className="queue-header">
                            <div className="queue-header-title">
                                <span className="queue-header-name">播放队列</span>
                                <span className="queue-header-count">{queue.length} 首</span>
                            </div>
                            <button
                                className="queue-clear"
                                type="button"
                                title="清空队列"
                                disabled={queue.length === 0}
                                onClick={() => player.clearQueue()}
                            >
                                <Icon name="trash" size={13}/>
                                <span>清空</span>
                            </button>
                        </div>

                        {!sortableEnabled ? (
                            <p className="queue-header-hint">
                                队列超过 {DRAG_REORDER_MAX} 首，拖拽排序已关闭
                            </p>
                        ) : null}

                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            onDragEnd={handleDragEnd}
                        >
                            <SortableContext items={keys} strategy={verticalListSortingStrategy}>
                                {body}
                            </SortableContext>
                        </DndContext>
                    </div>
                </CtxMenu.Trigger>

                <CtxMenu.Portal>
                    <CtxMenu.Content
                        className="context-menu queue-menu"
                        // 碰撞内边距
                        collisionPadding={14}
                        // 仅「窗口失焦」不关闭
                        onFocusOutside={(e) => e.preventDefault()}
                    >
                        <ContextMenu.Inherit className="queue-menu">
                            {menuRow !== undefined ? renderMenu(menuRow, menuIndex) : null}
                        </ContextMenu.Inherit>
                    </CtxMenu.Content>
                </CtxMenu.Portal>
            </CtxMenu.Root>
        </Popover>
    )
}
