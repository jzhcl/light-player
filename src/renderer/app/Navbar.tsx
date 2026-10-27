import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { closestCenter, DndContext, type DragEndEvent, PointerSensor, useSensor, useSensors, type PointerSensorOptions, } from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy, } from '@dnd-kit/sortable'
import { Icon } from '@renderer/components/Icon'

/** 导航栏拖拽阈值 */
const NAV_POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 3 } }
import { Popover } from '@renderer/components/ui/Popover'
import { AppLink } from '@renderer/components/ui/AppLink'
import { Cover } from '@renderer/components/ui/Cover'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { useNavigateTo } from '@renderer/hooks/useNavigateTo'
import { useRouter } from '@renderer/app/useRouter'
import { useAutoScroll } from '@renderer/hooks/useAutoScroll'
import { invoke } from '@renderer/lib/ipc'
import { isOk } from '@shared/result'
import { message } from '@renderer/lib/message'
import { generateId } from '@shared/utils'
import { NAVBAR_EXPAND_THRESHOLD } from '@renderer/lib/constants'
import {
    createPlaylist,
    deletePlaylist,
    getNextPlaylistName,
    updatePlaylist,
} from '@renderer/features/playlist/playlistService'
import { usePlaylistStore, useRouteHistoryStore, useSettingsStore, useDownloadStore } from '@renderer/store'

// 固定导航项
const NAV_ITEMS = [
    { id: 'recent', name: '最近', to: '/recent', icon: 'clock-history' as const },
    { id: 'liked', name: '我喜欢', to: '/liked', icon: 'heart' as const },
    { id: 'local-download', name: '本地与下载', to: '/local-download', icon: 'download' as const },
]

// 歌单名最大长度
const PLAYLIST_NAME_MAX = 10

interface PlaylistItemProps {
    playlist: LP.Playlist
    isEditing: boolean
    editValue: string
    pendingDelete: boolean
    onStartEdit: (playlist: LP.Playlist) => void
    onCommitName: (playlist: LP.Playlist) => void
    onCancelEdit: () => void
    onEditChange: (value: string) => void
    onRequestDelete: (id: string) => void
    onCancelDelete: () => void
    renderDeleteConfirm: (playlist: LP.Playlist) => ReactNode
}

// 单个用户歌单项：可拖拽排序（仅展开态 / 非编辑态 启用）、双击重命名、悬停出现删除按钮
function PlaylistItem(props: PlaylistItemProps) {
    const {
        playlist,
        isEditing,
        editValue,
        pendingDelete,
        onStartEdit,
        onCommitName,
        onCancelEdit,
        onEditChange,
        onRequestDelete,
        onCancelDelete,
        renderDeleteConfirm,
    } = props

    const inputRef = useRef<HTMLInputElement>(null)

    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: playlist.id, disabled: isEditing || pendingDelete })

    // 进入编辑态后自动聚焦并全选文本
    useEffect(() => {
        if (isEditing && inputRef.current) {
            inputRef.current.focus()
            inputRef.current.select()
        }
    }, [isEditing])

    const style: React.CSSProperties = {
        // 仅保留垂直位移
        transform: transform ? `translate3d(0px, ${transform.y}px, 0)` : undefined,
        transition,
        zIndex: isDragging ? 20 : undefined,
    }

    return (
        <AppLink
            to={`/playlist/${playlist.id}`}
            ref={setNodeRef}
            style={style}
            className={({ isActive }) =>
                `navbar-item h-center${isActive ? ' navbar-item--active' : ''}` +
                (isDragging ? ' is-dragging' : '')
            }
            title={playlist.name}
            {...attributes}
            {...(!isEditing && !pendingDelete ? listeners : {})}
        >
            {/* 有封面就用封面，没有才落到图标 */}
            <span className="navbar-item-icon center" aria-hidden="true">
                {playlist.pic?.url || playlist.pic?.path ? (
                    <Cover pic={playlist.pic} className="navbar-item-cover"/>
                ) : (
                    <Icon name="music-note-list"/>
                )}
            </span>

            {!isEditing && (
                <span
                    className="navbar-item-text ellipsis"
                    onDoubleClick={(e) => {
                        e.preventDefault()
                        onStartEdit(playlist)
                    }}
                >
                    {playlist.name}
                </span>
            )}

            {isEditing && (
                <input
                    ref={inputRef}
                    className="navbar-edit-input"
                    value={editValue}
                    maxLength={PLAYLIST_NAME_MAX}
                    onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                    }}
                    onChange={(e) => onEditChange(e.target.value)}
                    onBlur={() => onCommitName(playlist)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            onCommitName(playlist)
                        } else if (e.key === 'Escape') {
                            e.preventDefault()
                            onCancelEdit()
                        }
                    }}
                />
            )}

            {!isEditing && (
                <Popover
                    open={pendingDelete}
                    onOpenChange={(o) => {
                        if (!o) onCancelDelete()
                    }}
                    side="top"
                    align="end"
                    className="popover--navbar"
                    anchor={
                        <button
                            type="button"
                            className={`navbar-delete-button center${pendingDelete ? ' is-open' : ''}`}
                            title="删除歌单"
                            onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                onRequestDelete(playlist.id)
                            }}
                        >
                            <Icon name="x"/>
                        </button>
                    }
                >
                    {renderDeleteConfirm(playlist)}
                </Popover>
            )}
        </AppLink>
    )
}

/**
 * 展开/收起按钮 +（收起态）悬停弹出的快捷操作。
 *
 * 单独成组件是为了把「悬停即变化」的状态圈在这一小块里：若 showQuickActions 挂在 Navbar 上，
 * 指针每次掠过这个按钮都会让整个 Navbar（含 DndContext / 全部歌单项 / ScrollArea）重渲染一遍。
 */
function NavToggleArea({
    expanded,
    animateToggle,
    onToggle,
}: {
    expanded: boolean
    animateToggle: boolean
    onToggle: () => void
}) {
    const [showQuickActions, setShowQuickActions] = useState(false)
    const timer = useRef<number | null>(null)

    // 卸载时清理延迟隐藏定时器，避免泄露
    useEffect(
        () => () => {
            if (timer.current) window.clearTimeout(timer.current)
        },
        [],
    )

    // 收起态：悬停 toggle 区时弹出快捷操作（设置）
    const handleEnter = useCallback(() => {
        if (expanded) return
        if (timer.current) window.clearTimeout(timer.current)
        setShowQuickActions(true)
    }, [expanded])

    const handleLeave = useCallback(() => {
        // 延迟关闭：给指针从 toggle 移到弹出项留出时间（二者间有 4px 间隙）
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => setShowQuickActions(false), 100)
    }, [])

    return (
        <div className="navbar-toggle-area" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
            {/* 收起态快捷操作（设置）：悬停 toggle 区时旋转弹出，仅收起态生效 */}
            <div
                className={`navbar-quick-actions flex-v${showQuickActions && !expanded ? ' navbar-quick-actions--visible' : ''}`}
            >
                <AppLink to="/settings" className="navbar-quick-action-item center" title="设置" draggable={false}>
                    <span className="navbar-item-icon center" aria-hidden="true">
                        <Icon name="gear"/>
                    </span>
                </AppLink>
            </div>
            <button
                type="button"
                className={`navbar-toggle center${expanded ? ' navbar-toggle--expanded' : ''}${animateToggle ? ' navbar-toggle--animate' : ''}`}
                title={expanded ? '收起导航栏' : '展开导航栏'}
                onClick={onToggle}
            >
                <span className="navbar-toggle-icon center">
                    <Icon name="chevron-right"/>
                </span>
            </button>
        </div>
    )
}

// 侧边导航：固定项 + 我的歌单（双击重命名/拖拽排序/删除）+ 底部收起/设置。
// 展开态由 settings['ui.navbarExpanded'] 驱动，宽度与文字显隐均通过 data-expanded 交给 CSS。
export const Navbar = React.memo(function Navbar() {
    const router = useRouter()
    const navigateTo = useNavigateTo()
    const expanded = useSettingsStore((s) => s.settings['ui.navbarExpanded'])
    const setSetting = useSettingsStore((s) => s.setSetting)
    const playlists = usePlaylistStore((s) => s.playlists)
    const activeCount = useDownloadStore((s) => s.activeCount)

    const scrollRef = useRef<HTMLDivElement>(null)

    // 展开/收起图标旋转，初始化不播放动画。
    const [animateToggle, setAnimateToggle] = useState(false)
    useEffect(() => {
        setAnimateToggle(true)
    }, [])

    // 行内重命名
    const [editingId, setEditingId] = useState<string | null>(null)
    const [editValue, setEditValue] = useState('')
    const editingIdRef = useRef<string | null>(null)

    // 删除二次确认
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)

    // 用于屏蔽拖拽结束后的误触 click
    const dragOngoing = useRef(false)

    const sensors = useSensors(
        useSensor(PointerSensor, NAV_POINTER_SENSOR_OPTIONS),
    )

    // 拖拽平滑自动滚动
    const { start: startAutoScroll, stop: stopAutoScroll, update: updateAutoScroll } =
        useAutoScroll({ scrollRef })

    // 稳定引用：保证 handleDragStart 添加的监听器与 handleDragEnd 移除的是同一实例
    const onDragPointerMove = useCallback(
        (e: PointerEvent) => {
            updateAutoScroll(e.clientY)
        },
        [updateAutoScroll],
    )

    const enterEdit = (playlist: LP.Playlist) => {
        editingIdRef.current = playlist.id
        setEditValue(playlist.name)
        setEditingId(playlist.id)
    }

    const cancelEdit = () => {
        editingIdRef.current = null
        setEditingId(null)
    }

    // 展开/收起导航栏。
    // 展开且窗口过窄时先调宽窗口再展开，避免与 App 的「窄窗自动收起」effect 竞争
    const handleToggleNavbar = useCallback(() => {
        const next = !expanded
        if (next && window.innerWidth < NAVBAR_EXPAND_THRESHOLD) {
            const apply = () => setSetting('ui.navbarExpanded', true)
            const onResize = () => {
                window.removeEventListener('resize', onResize)
                apply()
            }
            window.addEventListener('resize', onResize)
            // 兜底：若 resize 事件未如期触发，仍展开
            window.setTimeout(() => {
                window.removeEventListener('resize', onResize)
                apply()
            }, 300)
            void invoke('mainWindow:setWindowSize', { width: NAVBAR_EXPAND_THRESHOLD })
        } else {
            setSetting('ui.navbarExpanded', next)
        }
    }, [expanded, setSetting])

    const commitName = async (playlist: LP.Playlist) => {
        // 防止 Enter 提交后 blur 重复触发
        if (editingIdRef.current !== playlist.id) return
        editingIdRef.current = null
        const trimmed = editValue.trim()
        setEditingId(null)
        // 空文本 / 未变化 → 回退取消，不写库
        if (!trimmed || trimmed === playlist.name) return
        const r = await updatePlaylist(playlist.id, { name: trimmed })
        if (!isOk(r)) {
            message.error(`重命名失败：${r.error}`)
            return
        }
        usePlaylistStore.getState().patchPlaylist(playlist.id, { name: trimmed })
    }

    const handleCreatePlaylist = async () => {
        const current = usePlaylistStore.getState().playlists
        const name = getNextPlaylistName(new Set(current.map((p) => p.name)))
        const id = generateId('playlist')
        const r = await createPlaylist({ id, pluginId: 'local', name })
        if (!isOk(r)) {
            message.error(`创建歌单失败：${r.error}`)
            return
        }

        // 编辑框仅在展开态可见，确保新建后立即进入编辑态能看见
        if (!expanded) setSetting('ui.navbarExpanded', true)
        const order = useSettingsStore.getState().settings['playlist.order']
        setSetting('playlist.order', [...order, id])

        enterEdit({ ...({ id } as LP.Playlist), name } as LP.Playlist)
        navigateTo(`/playlist/${id}`)
    }

    // 删除确认卡
    const renderDeleteConfirm = (playlist: LP.Playlist) => (
        <div className="popover-confirm">
            <div className="popover-confirm-text">确认删除歌单“{playlist.name}”？</div>
            <div className="popover-confirm-actions">
                <button
                    className="popover-confirm-cancel"
                    onClick={() => setPendingDeleteId(null)}
                >
                    取消
                </button>
                <button
                    className="popover-confirm-ok"
                    onClick={() => {
                        void doDelete(playlist)
                        setPendingDeleteId(null)
                    }}
                >
                    删除
                </button>
            </div>
        </div>
    )

    const doDelete = async (playlist: LP.Playlist) => {
        const { id } = playlist
        const r = await deletePlaylist(id)
        if (!isOk(r)) {
            message.error(`删除歌单失败：${r.error}`)
            return
        }
        const order = useSettingsStore.getState().settings['playlist.order']
        setSetting('playlist.order', order.filter((x) => x !== id))

        // 清理路由历史
        const rh = useRouteHistoryStore.getState()
        const wasOnDeleted = rh.stack[rh.pointer]?.pathname === `/playlist/${id}`
        useRouteHistoryStore.getState().remove((rec) => rec.pathname === `/playlist/${id}`)

        // 删除「当前正在查看」的歌单：重定向到「上一个有效路由」，没有则回退 /recent
        if (wasOnDeleted) {
            const s = useRouteHistoryStore.getState()
            const rec = s.stack[s.pointer]
            if (rec) void router.navigate(rec.pathname + rec.search, { replace: true })
            else void router.navigate('/recent', { replace: true })
        }
        message.success(`已删除歌单「${playlist.name}」`)
    }

    const handleDragStart = () => {
        dragOngoing.current = true
        startAutoScroll()
        window.addEventListener('pointermove', onDragPointerMove)
    }

    const handleDragEnd = (e: DragEndEvent) => {
        const { active, over } = e
        if (over && active.id !== over.id) {
            const oldIndex = playlists.findIndex((p) => p.id === active.id)
            const newIndex = playlists.findIndex((p) => p.id === over.id)
            if (oldIndex !== -1 && newIndex !== -1) {
                const newOrder = arrayMove(playlists, oldIndex, newIndex).map((p) => p.id)
                usePlaylistStore.getState().reorderPlaylistsTo(newOrder)
                setSetting('playlist.order', newOrder)
            }
        }
        // 拖拽结束：移除指针监听、停止自动滚动
        window.removeEventListener('pointermove', onDragPointerMove)
        stopAutoScroll()
        // 拖拽结束后拦截浏览器补发的 click ，待事件循环过后再解除
        setTimeout(() => {
            dragOngoing.current = false
        }, 0)
    }

    // 拖拽取消时立即解除拦截并停止自动滚动
    const handleDragCancel = () => {
        dragOngoing.current = false
        window.removeEventListener('pointermove', onDragPointerMove)
        stopAutoScroll()
    }

    // 拖拽结束后的误触 click（含落在固定项上）统一在此拦截
    const handleRootClickCapture = (e: React.MouseEvent) => {
        if (dragOngoing.current) {
            e.preventDefault()
            e.stopPropagation()
        }
    }

    const itemClass = ({ isActive }: { isActive: boolean }) =>
        `navbar-item h-center${isActive ? ' navbar-item--active' : ''}`

    return (
        <div className="navbar flex-v" data-expanded={expanded} onClickCapture={handleRootClickCapture}>
            <div className="navbar-inner flex-v">
                {/* 顶部：固定导航 + 分隔 + 歌单标题，置于滚动区之外。
                    目的：展开/收起过渡时「我的歌单」标题的高度变化（max-height 60→0）不再影响
                    滚动内容高度，避免滚动到底部切换时因 scrollHeight 逐帧变化而持续重排卡顿 */}
                <div className="navbar-fixed flex-v">
                    <div className="navbar-group flex-v">
                    {NAV_ITEMS.map((item) => {
                        const isDownload = item.id === 'local-download'
                        const showBar = isDownload && activeCount > 0
                        return (
                        <AppLink key={item.id} to={item.to} className={itemClass} title={item.name}
                                 draggable={false}>
                            <span className="navbar-item-icon center" aria-hidden="true">
                                <Icon name={item.icon}/>
                            </span>
                            <span className="navbar-item-text ellipsis">{item.name}</span>
                            {showBar && <span className="navbar-download-bar" role="progressbar" aria-label="下载中" />}
                        </AppLink>
                        )
                    })}
                    </div>

                    <div className="navbar-divider"/>

                    <div className="navbar-section-header">
                        <span className="navbar-section-title">我的歌单</span>
                        <button
                            type="button"
                            className="icon-button navbar-add-playlist center"
                            title="新建歌单"
                            onClick={handleCreatePlaylist}
                        >
                            <Icon name="add"/>
                        </button>
                    </div>
                </div>

                <ScrollArea
                    className="navbar-scroll-wrap"
                    scrollClassName="navbar-scroll flex-v"
                    thumbClassName="navbar-scroll-thumb"
                    trigger="hover"
                    autoHide
                    hideDelay={800}
                    deps={[expanded, playlists.length]}
                    scrollRef={scrollRef}
                >
                    <div className="navbar-group flex-v">
                        <DndContext
                            sensors={sensors}
                            collisionDetection={closestCenter}
                            autoScroll={false}
                            onDragStart={handleDragStart}
                            onDragEnd={handleDragEnd}
                            onDragCancel={handleDragCancel}
                        >
                            <SortableContext
                                items={playlists.map((p) => p.id)}
                                strategy={verticalListSortingStrategy}
                            >
                                {playlists.map((playlist) => (
                                    <PlaylistItem
                                        key={playlist.id}
                                        playlist={playlist}
                                        isEditing={editingId === playlist.id}
                                        editValue={editValue}
                                        pendingDelete={pendingDeleteId === playlist.id}
                                        onStartEdit={enterEdit}
                                        onCommitName={commitName}
                                        onCancelEdit={cancelEdit}
                                        onEditChange={setEditValue}
                                        onRequestDelete={setPendingDeleteId}
                                        onCancelDelete={() => setPendingDeleteId(null)}
                                        renderDeleteConfirm={renderDeleteConfirm}
                                    />
                                ))}
                            </SortableContext>
                        </DndContext>
                    </div>
                </ScrollArea>

                <div className="navbar-footer h-center">
                    <NavToggleArea
                        expanded={expanded}
                        animateToggle={animateToggle}
                        onToggle={handleToggleNavbar}
                    />
                    {/* 展开态设置项（收起态由 CSS 隐藏，避免与上方弹出项重复） */}
                    <AppLink to="/settings" className={itemClass} title="设置" draggable={false}>
                        <span className="navbar-item-icon center" aria-hidden="true">
                            <Icon name="gear"/>
                        </span>
                        <span className="navbar-item-text ellipsis">设置</span>
                    </AppLink>
                </div>
            </div>
        </div>
    )
})
