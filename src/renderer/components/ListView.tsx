import React, {
    memo,
    useCallback,
    useEffect,
    useImperativeHandle,
    useMemo,
    useRef,
    useState,
    type KeyboardEvent as ReactKeyboardEvent,
    type MouseEvent as ReactMouseEvent,
    type ReactNode,
    type Ref,
} from 'react'
import {
    closestCenter,
    DndContext,
    PointerSensor,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DraggableSyntheticListeners,
    type PointerSensorOptions,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import * as CtxMenu from '@radix-ui/react-context-menu'
import { useRowSelection, type SelectionMode } from '@renderer/hooks/useRowSelection'
import { useNearestFocusScroll } from '@renderer/hooks/useNearestFocusScroll'
import { useProgressiveCount, type ProgressiveOptions } from '@renderer/hooks/useProgressiveCount'
import { isBlurDismiss } from '@renderer/lib/overlay'
import { ContextMenu } from './ContextMenu'

/**
 * PointerSensor 的选项。必须是稳定引用（见 `sensors` 处的说明）：
 * `useSensor` 的 memo 依赖含 options，内联字面量会让传感器每渲染换一次身份，
 * 进而把 `DndContext` 的 context 打穿，所有 `useSortable` 行全部重渲。
 */
const POINTER_SENSOR_OPTIONS: PointerSensorOptions = { activationConstraint: { distance: 5 } }

/**
 * 通用列表容器（headless 的行容器序列）。
 *  - 渲染顺序、行容器的鼠标 / 键盘事件、选中状态机、右键菜单的显隐。
 *  - items 由外部提供，唯一性由外部 getKey 决定。
 *  - 不渲染行内容，由外部提供 renderRow。
 *  - 行容器由列表附加状态类（`is-selected`）与语义属性（`aria-selected` / `data-list-index`），
 *    其余类名与 DOM 属性由页面的 rowProps / rowClassName 给。
 *  - 选择模式分单选 / 多选，见 selectionMode
 */

/** 行在外壳期的位置信息 */
export interface RowIdentity {
    /** 该行的唯一 key（由外部 getKey 产出） */
    key: string
    index: number
}

/**
 * 行渲染上下文：在外壳信息之外，额外带本行的选中态。
 *
 * `selected` 由行自己订阅得出，只在本行翻转时才会重跑 renderRow —— 页面可以放心用它决定
 * 行内容（勾选框、选中态差异），不会因此牵连其它行。
 */
export interface ListRowContext extends RowIdentity {
    selected: boolean
}

/**
 * 行容器会注入的 DOM 属性。必须放在透传的 `...rest` 之前，这样页面若显式传入同名属性，
 * 以页面的为准 —— 事件处理器是合的（我们和页面都会执行），其余属性是覆盖的。
 *
 * 例外：`aria-selected` 由列表在 `...rest` 之后写入 —— 选中状态归列表所有，ARIA 跟着状态走。
 *
 * 注意 `role` 与 `aria-selected` 不在 `React.ComponentProps<'div'>` 里
 * （前者在 HTMLAttributes、后者在 AriaAttributes），我们额外补上。
 */
type ListRowInnerProps = React.ComponentProps<'div'> & {
    role?: React.AriaRole
    'aria-selected'?: React.AriaAttributes['aria-selected']
}

/** 选择访问器 */
export interface ListSelection<T> {
    keys: ReadonlySet<string>
    /** 最后操作的行 key（锚点），多选连选的起点 */
    last: string | null
    /** 触发本次操作的行 key（右键行），即菜单「作用于谁」 */
    contextKey: string | null
    /** 选中行数据，按行序 */
    rows: T[]
    count: number
}

export interface ListMenuArg<T> {
    /** 触发右键的那一行 */
    item: T
    index: number
    /** 收敛后的选区：右键行不在选区内时 = 仅该行；在选区内时 = 整个选区 */
    selection: ListSelection<T>
}

/**
 * 拖拽排序配置（可选）。给出即开启「整行拖拽重排」。
 *
 * 只接指针 / 触摸，**不接键盘拖拽**：行的 Enter 已经是「激活（播放）」，
 * 而 dnd-kit 的键盘传感器默认也吃 Space / Enter，两者会打架。
 */
export interface ListSortableOptions {
    /**
     * 拖拽落定（落点有效、且顺序确有变化时触发一次）。
     * 入参是重排后的全量 key 顺序（与 items 一一对应），页面据此重排数据源并落库。
     *
     * `info` 是被拖动的那一对下标：只有 `[min, max]` 区间内的 position 变了，
     * 页面落库时可以据此避免全量写。
     */
    onReorder: (keys: string[], info: { from: number; to: number }) => void
}

export interface ListViewProps<T> {
    /** 行数据（外部持有，列表不修改） */
    items: readonly T[]
    /** 行唯一 key —— 列表据此维护选择集，需跨渲染稳定 */
    getKey: (item: T, index: number) => string
    /** 行内容渲染（行容器的 className / 事件等 DOM 属性由下方 rowProps 统一给出） */
    renderRow: (item: T, ctx: ListRowContext) => ReactNode
    /**
     * 行容器的 DOM 属性（函数形式可按行给值）。
     *
     * 让页面在不放弃「列表只管容器」的前提下补齐结构与语义：
     * 语义角色（`role`）、可访问名称、逐行 title 等。
     *
     * 页面传入的同名属性优先（事件处理器除外——那是合的，两边都会执行）。
     *
     * 函数形式必须是纯函数、且由 useMemo / useCallback 稳定身份：列表按
     * `(行对象身份, index)` 缓存返回值，函数一换身份就视为「闭包看到的外部状态变了」→ 整表重建缓存。
     */
    rowProps?: Partial<ListRowInnerProps> | ((item: T, ctx: RowIdentity) => Partial<ListRowInnerProps>)
    /**
     * 行容器附加类名（列表已加 is-selected / is-dragging 等状态类）。
     * 与 rowProps 同理，入参是 `RowIdentity`；同样要求纯函数 + 稳定身份。
     */
    rowClassName?: string | ((item: T, ctx: RowIdentity) => string)
    className?: string

    /**
     * 选择模式（默认 `'single'`）：
     *  - `'single'` 单选 —— ctrl / shift 点击降级为普通点击
     *  - `'multi'`  多选 —— ctrl 切换、shift 区间连选、Ctrl+A 全选
     *
     * 两种模式共有：单击选中该行、右键行不在选区时先收敛到该行、
     * 点击行外部或按 ESC 清空选区。
     */
    selectionMode?: SelectionMode
    /** 受控选中集 */
    selection?: ReadonlySet<string>
    onSelectionChange?: (keys: Set<string>, last: string | null) => void
    /** 双击 / 回车激活 */
    onActivate?: (item: T, index: number) => void

    /**
     * 右键菜单内容（外部渲染）。列表负责显隐、定位与「右键行不在选区时先收敛选区」
     */
    renderContextMenu?: (arg: ListMenuArg<T>) => ReactNode

    /**
     * 附加到菜单容器的类名（根菜单与子菜单都会挂上）。
     *
     * 菜单经 Portal 渲染到 body，脱离了使用处的 DOM，选择器选不中宿主环境，
     * 故由使用处显式给出修饰类。子菜单同样是独立 Portal，拿不到根容器的类名，
     * 由内部 Context 透传同一份。
     */
    menuClassName?: string

    /** 命令式句柄（全选 / 清空 / 聚焦），供页面工具栏等外部入口调用 */
    listRef?: Ref<ListViewHandle>

    /**
     * 渐进渲染：首屏只渲染 initial 行，其余在浏览器空闲时按批追加，
     * 避免一次长任务卡住主线程。默认关闭。
     *
     * 选择状态机始终基于全量 items，因此「全选 / 区间连选」不受渲染进度影响。
     * 切换数据源（换歌单）时用 key 重挂载 ListView 即可把进度重置回首屏量。
     */
    progressive?: boolean | ProgressiveOptions

    /**
     * 拖拽排序（可选，默认关闭）。给出即「整行可拖」，在落点有效时回调新顺序。
     *
     * 开启后行容器会多一层 dnd-kit 的 `useSortable` 包装（仅指针 / 触摸）。
     */
    sortable?: ListSortableOptions
}

export interface ListViewHandle {
    selectAll: () => void
    clear: () => void
    focus: () => void
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set()

/** 菜单当前打开在哪一行 */
interface MenuAnchor {
    key: string
    index: number
}

/** 行的「外壳」：与选中态无关的那部分，随列表数据与列配置变化，故整体可复用 */
interface RowShell<T> {
    id: RowIdentity
    item: T
    rest: Partial<ListRowInnerProps> | undefined
    extra: string | undefined
}

/**
 * 行外壳的跨渲染缓存。
 *
 * `rowProps` / `rowClassName` 一并记下来，是为了判断「这两个工厂还是不是上一次那个函数」——
 * 换了身份就意味着它们闭包捕获的外部状态变了，缓存里的 `rest` / `extra` 可能已经过期。
 */
interface ShellCache<T> {
    rowProps: ListViewProps<T>['rowProps']
    rowClassName: ListViewProps<T>['rowClassName']
    byKey: Map<string, RowShell<T>>
}

/**
 * 拖拽挂载点：由可拖拽版行容器（SortableRowImpl）从 `useSortable` 取到后交给 RowImpl。
 * 这样「行长什么样」只有一份实现 —— 拖不拖，只是外面套不套这一层。
 */
interface RowDrag {
    setNodeRef: (el: HTMLElement | null) => void
    listeners: DraggableSyntheticListeners
    style: React.CSSProperties
    isDragging: boolean
}

interface RowProps<T> extends RowShell<T> {
    selected: boolean
    renderRow: (item: T, ctx: ListRowContext) => ReactNode
    onRowClick: (index: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
    onActivate?: (item: T, index: number) => void
    /** 拖拽挂载点；仅开启 sortable 时由 SortableRow 传入 */
    drag?: RowDrag
}

/**
 * 行容器。选中态只认自己这一位，`selected` 是唯一的易变入参 —— 于是 memo 只会在本行翻转时失效，
 * 一次点击的重渲染范围 = 1~2 行，与列表长度无关。
 */
function RowImpl<T>({ id, item, rest, extra, selected, renderRow, onRowClick, onActivate, drag }: RowProps<T>) {
    return (
        <div
            {...rest}
            // 拖拽监听只含 onPointerDown，与下面的 onClick / onDoubleClick 不同名，不会互相顶掉
            {...drag?.listeners}
            ref={drag?.setNodeRef}
            style={drag ? { ...rest?.style, ...drag.style } : rest?.style}
            className={[
                rest?.className,
                'list-row',
                extra,
                selected ? 'is-selected' : '',
                drag?.isDragging ? 'is-dragging' : '',
            ]
                .filter(Boolean)
                .join(' ')}
            // 写在 ...rest 之后：选中态归列表所有，页面不必也不该在 rowProps 里给这个属性
            aria-selected={selected}
            data-list-index={id.index}
            tabIndex={rest?.tabIndex ?? 0}
            onClick={(e) => {
                rest?.onClick?.(e)
                onRowClick(id.index, e)
            }}
            onDoubleClick={(e) => {
                rest?.onDoubleClick?.(e)
                onActivate?.(item, id.index)
            }}
        >
            {renderRow(item, { ...id, selected })}
        </div>
    )
}

/**
 * 行级 memo 边界。
 *
 * 必须定义在模块级：若写进 ListViewInner，每次渲染都会产生新的组件类型，React 会把整表
 * 卸载重挂（DOM、焦点、图片全部重来），比不 memo 还糟。
 *
 * `as typeof RowImpl` 只为保住泛型签名（React.memo 会把它擦成非泛型组件类型）。
 */
const Row = memo(RowImpl) as typeof RowImpl

/**
 * 可拖拽版行：`useSortable` 必须处在 SortableContext 内，故另起一层组件，
 * 取到 ref / listeners / transform 后原样交给 RowImpl —— 行的 DOM 只有一份实现。
 *
 * 位移只取 y：列表是纵向的，x 无意义。
 * 行级 memo 同样成立：只有被拖的行与需要让位的行会拿到新的 transform 而重渲染。
 */
function SortableRowImpl<T>(props: RowProps<T>) {
    const { setNodeRef, listeners, transform, transition, isDragging } = useSortable({ id: props.id.key })
    const drag = useMemo<RowDrag>(
        () => ({
            setNodeRef,
            listeners,
            style: {
                transform: transform ? `translate3d(0px, ${transform.y}px, 0)` : undefined,
                transition,
            },
            isDragging,
        }),
        [setNodeRef, listeners, transform, transition, isDragging],
    )
    return <RowImpl {...props} drag={drag}/>
}

const SortableRow = memo(SortableRowImpl) as typeof SortableRowImpl

/**
 * 从行数据中按 key 集合挑出选中的行，保持原顺序。
 *
 * ListView 自己与页面共用同一实现 ——
 * 「keys → rows」若各写一份，早晚会在顺序或边界上漂移。
 *
 * 注意：页面要用自己那份全量 items 传进来，不要用渐进渲染的可见前缀。
 */
export function pickSelected<T>(
    items: readonly T[],
    getKey: (item: T, index: number) => string,
    keys: ReadonlySet<string>,
): T[] {
    if (keys.size === 0) return []
    const out: T[] = []
    for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item !== undefined && keys.has(getKey(item, i))) out.push(item)
    }
    return out
}

/**
 * 菜单内容宿主：把 renderContextMenu 的调用推迟到菜单真正挂载时，
 * 避免列表每次渲染都构建一遍菜单树。
 */
function MenuHost<T>({
    item,
    index,
    getSelection,
    render,
}: {
    item: T
    index: number
    getSelection: () => ListSelection<T>
    render: (arg: ListMenuArg<T>) => ReactNode
}) {
    return <>{render({ item, index, selection: getSelection() })}</>
}

function ListViewInner<T>({
    items,
    getKey,
    renderRow,
    rowProps,
    rowClassName,
    className,
    selectionMode = 'single',
    selection,
    onSelectionChange,
    onActivate,
    renderContextMenu,
    menuClassName,
    progressive,
    sortable,
    listRef,
}: ListViewProps<T>) {
    const rootRef = useRef<HTMLDivElement | null>(null)
    // 最近一次操作的行 key（锚点），供选择访问器对外暴露
    const lastRef = useRef<string | null>(null)
    // 当前打开着菜单的行。同一时刻至多一个菜单，故只需一个值
    const [menu, setMenu] = useState<MenuAnchor | null>(null)
    // menu 的同步镜像：document 上的捕获监听必须在事件当下读到最新值，等不到 state 提交
    const menuRef = useRef<MenuAnchor | null>(null)
    // contextmenu 命中的行。Radix 的 Trigger 在同一个事件里紧跟着读它，决定「开哪一行」
    const pendingRef = useRef<MenuAnchor | null>(null)
    const current = selection ?? EMPTY_SELECTION
    // 拖拽刚结束、下一次 pointerdown 之前的那次 click 要吞掉（见 onRowClick）
    const suppressClickRef = useRef(false)

    /**
     * 拖拽传感器：只接指针（触摸由 PointerSensor 一并覆盖）。
     * 距离阈值 5px —— 足够滤掉点击时的手抖，又不至于拖起来发钝。
     *
     * ⚠️ options 必须是模块级常量，不能写内联字面量：`useSensor(sensor, options)` 的
     * memo 依赖是 `[sensor, options]`，字面量每次渲染都换身份 ⇒ 传感器描述对象变 ⇒
     * `useSensors` 的 `[...sensors]` 逐项比较失败 ⇒ `DndContext` 收到新 `sensors` ⇒
     * context 值更新 ⇒ 每个 `useSortable` 消费者全表重渲。
     */
    const sensors = useSensors(useSensor(PointerSensor, POINTER_SENSOR_OPTIONS))

    // 渐进渲染：只渲染前缀，未渲染的部分不影响选择状态机（rowKeys 仍是全量）
    const progressiveEnabled = progressive !== undefined && progressive !== false
    const renderCount = useProgressiveCount(
        items.length,
        progressiveEnabled,
        typeof progressive === 'object' ? progressive : undefined,
    )
    // 记忆化：渐进渲染期间 slice 每次都产出新数组，会把下面的 shells 连带打掉
    const visibleItems = useMemo(
        () => (renderCount >= items.length ? items : items.slice(0, renderCount)),
        [items, renderCount],
    )

    const setMenuOpen = useCallback((next: MenuAnchor | null) => {
        menuRef.current = next
        setMenu(next)
    }, [])

    // 菜单内容节点：键盘导航时把「聚焦滚动」压到最小位移（见 hook 注释）
    const setMenuContent = useNearestFocusScroll<HTMLDivElement>()

    const rowKeys = useMemo(() => items.map((item, i) => getKey(item, i)), [items, getKey])
    // 内部已持 rowKeys，按索引取即可 —— 不为了同一份 key 再跑一遍 getKey
    const keyOfIndex = useCallback((_item: T, index: number) => rowKeys[index] as string, [rowKeys])

    // 行被移除后清掉指向已卸载行的菜单状态，避免同 key 复现时误开
    useEffect(() => {
        const open = menuRef.current
        if (open !== null && !rowKeys.includes(open.key)) setMenuOpen(null)
    }, [menu, rowKeys, setMenuOpen])

    const emit = useCallback(
        (next: Set<string>, last: string | null) => {
            lastRef.current = last
            onSelectionChange?.(next, last)
        },
        [onSelectionChange],
    )
    const { handleRowClick, selectAll, clear, prepareContextMenu, getContextKey } = useRowSelection({
        rowKeys,
        selection: current,
        mode: selectionMode,
        onChange: emit,
    })

    /**
     * 拖拽落定：把「新顺序」交给页面（只按 key 判序）。
     *
     * 同时打开「吞掉误触 click」的开关 —— 浏览器在 pointerup 之后还会补一个 click，
     * 若按下与抬起落在同一行上（小幅拖动）就会顺带把该行选中。
     */
    const handleDragEnd = useCallback(
        (e: DragEndEvent) => {
            suppressClickRef.current = true
            const { active, over } = e
            if (over && active.id !== over.id) {
                const from = rowKeys.indexOf(String(active.id))
                const to = rowKeys.indexOf(String(over.id))
                if (from !== -1 && to !== -1) sortable?.onReorder(arrayMove(rowKeys, from, to), { from, to })
            }
        },
        [rowKeys, sortable],
    )

    /** 拖拽取消：同样拦下随后的 click，免得多选一行 */
    const handleDragCancel = useCallback(() => {
        suppressClickRef.current = true
    }, [])

    /**
     * 复位拦截：下一次按下即放行。
     * 用 pointerdown 而不是 setTimeout —— click 必定早于下一次按下，时序上确定，
     * 不依赖事件循环的调度细节。
     */
    useEffect(() => {
        if (!sortable) return
        const reset = () => {
            suppressClickRef.current = false
        }
        document.addEventListener('pointerdown', reset, true)
        return () => document.removeEventListener('pointerdown', reset, true)
    }, [sortable])

    /** 行点击：包一层拦截，其余逻辑仍归 useRowSelection */
    const onRowClick = useCallback(
        (index: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
            if (suppressClickRef.current) return
            handleRowClick(index, event)
        },
        [handleRowClick],
    )

    useImperativeHandle(
        listRef,
        () => ({
            selectAll,
            clear,
            focus: () => rootRef.current?.focus(),
        }),
        [selectAll, clear],
    )

    /**
     * 右键命中检测：挂在列表容器上，冒泡阶段用 closest 找到被点中的行。
     *
     * 计时上必须早于 Radix Trigger 自己的 onContextMenu（二者是同一个元素上被组合的两个
     * handler，我们排在前面），这样 pendingRef 已就位，Radix 触发打开时才能读到「哪一行」。
     */
    const handleContextMenu = useCallback(
        (e: ReactMouseEvent<HTMLDivElement>) => {
            const el = (e.target as HTMLElement).closest<HTMLElement>('[data-list-index]')
            const index = el ? Number(el.dataset.listIndex) : NaN
            if (el === null || !Number.isInteger(index) || index < 0 || index >= rowKeys.length) {
                // 空白处右键：让 Radix 照常记锚点，但 onOpenChange 收到 true 时不会开菜单
                pendingRef.current = null
                return
            }
            const hit: MenuAnchor = { key: rowKeys[index] as string, index }
            pendingRef.current = hit
            prepareContextMenu(index)
            // 菜单已经开着又右键了另一行：Radix 的受控 open 值没变，不会回调 onOpenChange，
            // 必须自己换行，否则菜单会「停在上一行」。
            if (menuRef.current !== null) setMenuOpen(hit)
        },
        [rowKeys, prepareContextMenu, setMenuOpen],
    )

    /** 收敛后的选区：右键行已在选区内则用整个选区，否则仅该行 */
    const resolveSelection = useCallback(
        (item: T, key: string): ListSelection<T> => {
            const contextKey = getContextKey()
            if (current.has(key)) {
                const rows = pickSelected(items, keyOfIndex, current)
                return { keys: current, last: lastRef.current, contextKey, rows, count: rows.length }
            }
            return { keys: new Set([key]), last: key, contextKey, rows: [item], count: 1 }
        },
        [current, items, keyOfIndex, getContextKey],
    )

    // Ctrl+A 全选（仅多选）/ 回车激活：行可聚焦（tabIndex=0），键盘事件冒泡到根容器统一处理
    const onKeyDown = useCallback(
        (e: ReactKeyboardEvent<HTMLDivElement>) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                if (selectionMode !== 'multi') return
                e.preventDefault()
                selectAll()
                return
            }
            if (e.key === 'Enter' && onActivate) {
                const el = (e.target as HTMLElement).closest<HTMLElement>('[data-list-index]')
                if (!el) return
                const index = Number(el.dataset.listIndex)
                const item = items[index]
                if (item === undefined) return
                e.preventDefault()
                onActivate(item, index)
            }
        },
        [selectionMode, selectAll, onActivate, items],
    )

    /**
     * 点击非行区域 / 按下 ESC：清空选区
     *
     * 两条硬性实现约束：
     *  1. 必须走 document 捕获阶段。Radix ContextMenu 是 modal 的，打开时会给 body 加
     *     `pointer-events: none`，冒泡阶段 target 退化成 <html>；且 Radix 自己的 dismiss 监听
     *     也在 document 上。只有捕获阶段能保证在 menuRef 被置回 null 之前读到它。
     *  2. 菜单打开时短路：这一次操作只是在关菜单，不该顺带清掉选区。
     *     否则用户右键选中 3 行后只是想点别处收起菜单，选区就没了。
     *
     * 仅在确有选中时挂载，避免每个页面常驻全局监听。
     */
    useEffect(() => {
        if (current.size === 0) return

        const onPointerDown = (e: PointerEvent) => {
            if (menuRef.current !== null) return
            const target = e.target
            if (target instanceof HTMLElement && target.closest('[data-list-index]')) return
            clear()
        }
        const onKeyDown = (e: KeyboardEvent) => {
            // 已被别处消费（如 Modal / 面板的 ESC）时不抢
            if (e.defaultPrevented) return
            if (e.key !== 'Escape') return
            if (menuRef.current !== null) return
            clear()
        }

        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
        }
    }, [current.size, clear])

    /**
     * 行外壳：不含选中态。选中集变化时整段复用（id / rest / extra 引用不变），
     * 于是下面 memo 比较时只有 `selected` 一项可能不同 —— 这正是「只重渲染翻转的行」成立的前提。
     * 若把 selection 掺进来，300 行的 rest 每次点击都是新对象，memo 全体落空。
     *
     * ⚠️ 光靠 useMemo 不够：它的依赖含 `visibleItems`，数据源一换数组就会整段重算，
     * 而 `rowProps(item, id)` 每次都造新对象、`id` 也是新对象 ⇒ 行级 memo 全部落空。
     */
    const shellCacheRef = useRef<ShellCache<T>>({ rowProps: undefined, rowClassName: undefined, byKey: new Map() })
    const shells = useMemo(() => {
        const prev = shellCacheRef.current
        /**
         * 行属性工厂换了身份 ⇒ 闭包可能捕获了新状态，
         * 此时无法逐行判断 `rest` / `extra` 是否过期 —— 整表重建。
         */
        const reuse = prev.rowProps === rowProps && prev.rowClassName === rowClassName
        const hits = reuse ? prev.byKey : null

        const byKey = new Map<string, RowShell<T>>()
        const list = visibleItems.map((item, index) => {
            const key = rowKeys[index] as string
            const hit = hits?.get(key)
            // 行对象没换、下标也没动 → 连 id / rest / extra 一起复用
            if (hit !== undefined && hit.item === item && hit.id.index === index) {
                byKey.set(key, hit)
                return hit
            }
            // 下标没变时 id 也复用（rest 里的 aria-rowindex 依赖 index，变了就必须重建 id）
            const id: RowIdentity = hit !== undefined && hit.id.index === index ? hit.id : { key, index }
            const shell: RowShell<T> = {
                id,
                item,
                rest: typeof rowProps === 'function' ? rowProps(item, id) : rowProps,
                extra: typeof rowClassName === 'function' ? rowClassName(item, id) : rowClassName,
            }
            byKey.set(key, shell)
            return shell
        })

        shellCacheRef.current = { rowProps, rowClassName, byKey }
        return list
    }, [visibleItems, rowKeys, rowProps, rowClassName])

    // 开启 sortable 时换成可拖版行组件
    const RowComponent = (sortable ? SortableRow : Row) as typeof RowImpl

    const rows = shells.map((shell) => (
        <RowComponent
            key={shell.id.key}
            id={shell.id}
            item={shell.item}
            rest={shell.rest}
            extra={shell.extra}
            selected={current.has(shell.id.key)}
            renderRow={renderRow}
            onRowClick={onRowClick}
            onActivate={onActivate}
        />
    ))

    const list = (
        <div
            ref={rootRef}
            className={className}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            // 容器级委派：仅在确实要渲染菜单时才挂
            onContextMenu={renderContextMenu ? handleContextMenu : undefined}
        >
            {rows}
        </div>
    )

    /**
     * 拖拽排序的外壳：DndContext 建拖拽会话，SortableContext 提供顺序语义。
     *
     * 必须包在最外层（连 Radix 的 CtxMenu.Root 一起），不能只包住列表 div ——
     * 列表 div 是 `CtxMenu.Trigger asChild` 的直接子节点，Slot 会把触发器的
     * onContextMenu / ref 克隆到它身上；中间若夹一层 DndContext，这些 props 会落到
     * 根本不透传 DOM 属性的 DndContext 上，右键菜单就再也开不了。
     */
    const withDnd = (node: ReactNode) =>
        sortable ? (
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
                onDragCancel={handleDragCancel}
            >
                <SortableContext items={rowKeys} strategy={verticalListSortingStrategy}>
                    {node}
                </SortableContext>
            </DndContext>
        ) : (
            <>{node}</>
        )

    // 没有菜单需求：容器就是列表本身，零额外开销
    if (!renderContextMenu) return withDnd(list)

    const openItem = menu !== null && menu.index < items.length ? items[menu.index] : undefined

    return withDnd(
        <CtxMenu.Root
            // 受控显隐：Root 自带「window 失焦即关」且无从关闭（见 lib/overlay），
            // 只有受控才能在 onOpenChange 里拦下它——点开发者工具时菜单得以保留。
            open={openItem !== undefined}
            // 不铺全局遮罩：菜单打开时仍可与其它元素交互。
            // 代价是失去 Radix 自带的滚动锁，菜单打开时列表可滚动（位置由 Popper 跟随）。
            modal={false}
            onOpenChange={(open) => {
                if (open) {
                    // 锚点位置已由 Radix 的 Trigger 按指针坐标记好，这里只决定「开哪一行」
                    const hit = pendingRef.current
                    pendingRef.current = null
                    // 空白处右键：Radix 已经把 open 推成 true，但我们不接管 → 菜单不开
                    if (hit !== null) setMenuOpen(hit)
                    return
                }
                // 窗口已失焦 ⇒ 这次关闭来自 Radix 的 window blur 监听，忽略
                if (isBlurDismiss()) return
                setMenuOpen(null)
            }}
        >
            <CtxMenu.Trigger asChild>{list}</CtxMenu.Trigger>
            <CtxMenu.Portal>
                <CtxMenu.Content
                    ref={setMenuContent}
                    className={['context-menu', menuClassName].filter(Boolean).join(' ')}
                    // 碰撞内边距：既撑开菜单与窗口上下的间距，也决定
                    // --radix-context-menu-content-available-height（见 components.css 的 max-height）
                    collisionPadding={14}
                    // 仅「窗口失焦」不关闭（点开发者工具时菜单保留，便于查看 DOM 与样式）；
                    // 点击本窗口其它位置仍照常关闭
                    onFocusOutside={(e) => e.preventDefault()}
                >
                    <ContextMenu.Inherit className={menuClassName}>
                        {openItem !== undefined && menu !== null ? (
                            <MenuHost
                                item={openItem}
                                index={menu.index}
                                getSelection={() => resolveSelection(openItem, menu.key)}
                                render={renderContextMenu}
                            />
                        ) : null}
                    </ContextMenu.Inherit>
                </CtxMenu.Content>
            </CtxMenu.Portal>
        </CtxMenu.Root>
    )
}

/**
 * 外层 memo：页面因与列表无关的状态（loading / 计数 / 回填）重渲染时，列表整体不动。
 * 前提是页面把 items 与各类回调都做了稳定化（useMemo / useCallback）——见 useStableRows。
 * `as typeof ListViewInner` 只为保住泛型签名（React.memo 会把它擦成非泛型组件类型）。
 */
export const ListView = memo(ListViewInner) as typeof ListViewInner
