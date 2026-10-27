import * as Dialog from '@radix-ui/react-dialog'
import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { acquireModalDepth, releaseModalDepth } from '@renderer/lib/modalDepth'

/* ============================================================
   - ModalShell：骨架。遮罩 / 定位 / 焦点陷阱 / ESC / 点蒙层关闭，外加外壳盒
     （背景、边框、圆角、阴影、进出场动画都挂在 .modal-container 上，颜色归主题）。
   - Modal：程序内模态框。Shell + 默认骨架（标题 / 滚动区 / 内边距），
     并把「容器高度 → 滚动视口」的高度链打通。
   ============================================================ */

export interface ModalShellProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    children: ReactNode
    /** 场景 / 尺寸修饰类，落到 .modal-container 上 */
    className?: string
    /** 应用到 .modal-container 的内联样式（尺寸等） */
    contentStyle?: CSSProperties
    /** 无可见标题时的无障碍标签（渲染为 sr-only 的 Dialog.Title） */
    contentLabel?: string
    /** 点击蒙层（wrap 自身、非容器）是否关闭，默认 false */
    maskClosable?: boolean
    /** 按 ESC 是否关闭，默认 true */
    escClosable?: boolean
    /** z-index 层级号：0 = 插件层（默认），程序内对话框由 Modal 分配 */
    depth?: number
}

export function ModalShell({
    open,
    onOpenChange,
    children,
    className,
    contentStyle,
    contentLabel,
    maskClosable = false,
    escClosable = true,
    depth = 0,
}: ModalShellProps) {
    // mask 与 wrap 拿同一个 depth：同层的 wrap 高于同层的 mask
    const depthStyle = { '--modal-depth': depth } as CSSProperties

    /**
     * 缓存「打开时最后一次的 children」。
     *
     * ⚠️ Radix 的 Presence 在关闭动画结束前仍然挂着 Dialog.Content。此时如果调用方
     * 已经把 children 置空（最常见：关闭时顺手把列表数据 clear 掉），内容会先塌下去，
     * 动画期间就能看到弹窗高度突然缩一下 —— 不是动画问题，是内容先没了。
     * 关闭时继续用最后一次的内容渲染，动画就能按原来的高度退场。
     */
    const contentRef = useRef<ReactNode>(children)
    if (open) contentRef.current = children
    const stableChildren = open ? children : contentRef.current

    return (
        <Dialog.Root open={open} onOpenChange={onOpenChange}>
            <Dialog.Portal>
                <Dialog.Overlay className="modal-mask" style={depthStyle} />
                <Dialog.Content
                    className="modal-wrap"
                    style={depthStyle}
                    onEscapeKeyDown={(e) => {
                        if (!escClosable) e.preventDefault()
                    }}
                    onInteractOutside={(e) => {
                        if (!escClosable) e.preventDefault()
                    }}
                    // 仅当 maskClosable 时，点击蒙层区域（wrap 自身、非容器）关闭
                    onClick={
                        maskClosable
                            ? (e) => {
                                  if (e.target === e.currentTarget) onOpenChange(false)
                              }
                            : undefined
                    }
                >
                    <div className={`modal-container ${className ?? ''}`} style={contentStyle}>
                        {contentLabel && (
                            <Dialog.Title className="sr-only">{contentLabel}</Dialog.Title>
                        )}
                        {stableChildren}
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    )
}

export interface ModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    title?: ReactNode
    children: ReactNode
    /** 场景 / 尺寸修饰类，落到 .modal-container 上（自动叠加 .modal--dialog） */
    className?: string
    /** 点击蒙层是否关闭，默认 false */
    maskClosable?: boolean
    /** 应用到 .modal-container 的内联样式 */
    contentStyle?: CSSProperties
    /** 无可见标题时，为面板提供无障碍标签（渲染为 sr-only 的 Dialog.Title） */
    contentLabel?: string
    /** 按 ESC 是否关闭，默认 true */
    escClosable?: boolean
    /** 固定在弹窗底部的操作区 */
    footer?: ReactNode
}

export function Modal({
    open,
    onOpenChange,
    title,
    children,
    className,
    maskClosable = false,
    contentStyle,
    contentLabel,
    escClosable = true,
    footer,
}: ModalProps) {
    // 打开时取层级号、关闭时归还。
    const [depth, setDepth] = useState(0)
    useLayoutEffect(() => {
        if (!open) return
        const acquired = acquireModalDepth()
        setDepth(acquired)
        return () => releaseModalDepth(acquired)
    }, [open])

    return (
        <ModalShell
            open={open}
            onOpenChange={onOpenChange}
            className={`modal--dialog ${className ?? ''}`}
            contentStyle={contentStyle}
            // 有可见标题时它本身就是 Dialog.Title，无需再补 sr-only 标签
            contentLabel={title ? undefined : contentLabel}
            maskClosable={maskClosable}
            escClosable={escClosable}
            depth={depth}
        >
            <div className="modal-layout">
                {title && <Dialog.Title className="modal-title">{title}</Dialog.Title>}
                <ScrollArea
                    className="modal-scroll"
                    scrollClassName="modal-scroll-view"
                    thumbClassName="modal-scroll-thumb"
                    deps={[children]}
                >
                    <div className="modal-content">{children}</div>
                </ScrollArea>
                {footer && <div className="modal-footer">{footer}</div>}
            </div>
        </ModalShell>
    )
}
