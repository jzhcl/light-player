import * as PopoverPrimitive from '@radix-ui/react-popover'
import { useEffect, useState, type ReactNode, type RefObject } from 'react'

// 浮层：基于 Radix Popover，Portal 到 body，自动处理
// 视口碰撞定位、外部点击 / ESC 关闭。
// 受控用法：open / onOpenChange 由调用方持有；
// anchor 为触发元素（用 asChild 透传 ref），children 为浮层内容。
export interface PopoverProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    anchor: ReactNode
    children: ReactNode
    side?: 'top' | 'right' | 'bottom' | 'left'
    align?: 'start' | 'center' | 'end'
    sideOffset?: number
    /** 附加到壳层 `.popover` 上的类名。整卡载体的场景请一并带上 `popover--bare`。 */
    className?: string
    /** 是否渲染指向锚点的小三角 */
    arrow?: boolean
    /**
     * 浮层是否参与焦点管理：打开时把焦点移入浮层、关闭时移回触发元素（默认 true）。
     * 鼠标悬停触发的浮层要传 false —— 否则鼠标划过就抢走外部焦点，关闭时又把焦点抢回按钮。
     */
    autoFocus?: boolean
    /**
     * 锚点元素的 ref：点击 / 聚焦它不算「外部交互」，浮层不会因此关闭。
     */
    anchorRef?: RefObject<HTMLElement | null>
    /**
     * 首次打开后是否把浮层留在 DOM 里复用。
     *
     * 默认 false：随开合挂卸 —— 关闭时 Radix 会等退场动画播完再卸载整棵子树。
     * true：第一次打开才挂载，此后关闭只是摘出布局、
     * 不再卸载。内容重（长列表）的浮层用它，省掉每次打开重建整棵子树的开销。
     *
     * 两处代价：① 关闭期间 React 照常渲染（数据变了会重渲染这块看不见的 DOM）；
     * ② `onCloseAutoFocus` 只在卸载时跑 → 关闭时不再自动把焦点交回锚点。
     */
    keepMounted?: boolean
}

export function Popover({
    open,
    onOpenChange,
    anchor,
    children,
    side = 'right',
    align = 'center',
    sideOffset = 8,
    className,
    arrow = true,
    autoFocus = true,
    anchorRef,
    keepMounted = false,
}: PopoverProps) {
    const [everOpened, setEverOpened] = useState(open)
    useEffect(() => {
        if (open) setEverOpened(true)
    }, [open])
    const persist = keepMounted && everOpened

    return (
        <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
            <PopoverPrimitive.Anchor asChild>{anchor}</PopoverPrimitive.Anchor>
            {/* ⚠️ Portal 与 Content **各有一道 Presence**（见 dist/index.mjs 的 PopoverPortal / PopoverContent），
                只喂内层的话外层照样把整棵子树卸掉 —— 两边都得说「别卸」。
                Radix 的 forceMount 只管「不卸载」；关上之后藏起来得靠 `.popover--persist` 自己来 */}
            <PopoverPrimitive.Portal forceMount={persist || undefined}>
                <PopoverPrimitive.Content
                    forceMount={persist || undefined}
                    side={side}
                    align={align}
                    sideOffset={sideOffset}
                    collisionPadding={8}
                    className={`popover${persist ? ' popover--persist' : ''}${className ? ` ${className}` : ''}`}
                    onOpenAutoFocus={autoFocus ? undefined : (event) => event.preventDefault()}
                    onCloseAutoFocus={autoFocus ? undefined : (event) => event.preventDefault()}
                    onInteractOutside={(event) => {
                        const el = anchorRef?.current
                        if (el && event.target instanceof Node && el.contains(event.target)) {
                            event.preventDefault()
                        }
                    }}
                >
                    <div className="popover-inner">
                        {children}
                    </div>
                    {arrow && <PopoverPrimitive.Arrow className="popover-arrow" />}
                </PopoverPrimitive.Content>
            </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
    )
}
