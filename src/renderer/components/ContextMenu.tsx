import { createContext, useContext, type ReactNode } from 'react'
import * as CtxMenu from '@radix-ui/react-context-menu'
import type { IconName } from '@assets/icons'
import { useNearestFocusScroll } from '@renderer/hooks/useNearestFocusScroll'
import { Icon } from './Icon'
import { Cover, type PicLike } from './ui/Cover'

/**
 * 右键菜单内容部件（薄封装 Radix ContextMenu 的内容侧部件）
 */

/**
 * 类名透传
 */
const InheritContext = createContext('')

function Inherit({ className, children }: { className?: string; children: ReactNode }) {
    return <InheritContext.Provider value={className ?? ''}>{children}</InheritContext.Provider>
}

export interface ContextMenuItemProps {
    /** 左侧图标名（编译期内置图标） */
    icon?: IconName
    /** 左侧封面缩略图（歌单封面等）。有图时优先于 icon，无图则回落到 icon */
    pic?: PicLike
    disabled?: boolean
    onSelect?: () => void
    /** 附加类名 */
    className?: string
    children: ReactNode
}

function Item({ icon, pic, disabled, onSelect, className, children }: ContextMenuItemProps) {
    // 空 pic（{url:'',path:''}）与「没给 pic」等价 —— 都走 icon / 占位
    const hasPic = typeof pic === 'string' ? pic !== '' : Boolean(pic?.url || pic?.path)
    return (
        <CtxMenu.Item
            className={['context-menu-item', className].filter(Boolean).join(' ')}
            disabled={disabled}
            onSelect={onSelect}
        >
            {hasPic ? (
                <Cover pic={pic} className="context-menu-thumb"/>
            ) : icon ? (
                <Icon name={icon}/>
            ) : (
                <span className="context-menu-icon-slot" aria-hidden="true"/>
            )}
            <span className="context-menu-label">{children}</span>
        </CtxMenu.Item>
    )
}

function Separator() {
    return <CtxMenu.Separator className="context-menu-separator" />
}

export interface ContextMenuSubProps {
    label: ReactNode
    icon?: IconName
    disabled?: boolean
    children: ReactNode
}

function Sub({ label, icon, disabled, children }: ContextMenuSubProps) {
    const inherited = useContext(InheritContext)
    // 子菜单是独立的滚动容器，键盘导航的最小滚动也得挂一份
    const setSubContent = useNearestFocusScroll<HTMLDivElement>()
    return (
        <CtxMenu.Sub>
            <CtxMenu.SubTrigger className="context-menu-item has-children" disabled={disabled}>
                {icon ? (
                    <Icon name={icon} />
                ) : (
                    <span className="context-menu-icon-slot" aria-hidden="true" />
                )}
                <span className="context-menu-label">{label}</span>
                <Icon name="expand" size={14} className="context-menu-arrow" />
            </CtxMenu.SubTrigger>
            <CtxMenu.Portal>
                <CtxMenu.SubContent
                    ref={setSubContent}
                    className={['context-menu', 'context-menu--sub', inherited]
                        .filter(Boolean)
                        .join(' ')}
                    sideOffset={4}
                    alignOffset={-6}
                    collisionPadding={14}
                >
                    {children}
                </CtxMenu.SubContent>
            </CtxMenu.Portal>
        </CtxMenu.Sub>
    )
}

export const ContextMenu = { Item, Separator, Sub, Inherit }
