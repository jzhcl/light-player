import React, { forwardRef, useSyncExternalStore } from 'react'
import { useNavigateTo } from '@renderer/hooks/useNavigateTo'
import { getPathname, subscribeLocation } from '@renderer/app/locationStore'

interface AppLinkProps extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'className'> {
    to: string
    className?: string | ((props: { isActive: boolean }) => string)
}

// 细粒度「是否当前路由」：基于 locationStore 的 useSyncExternalStore。
// 快照是布尔值 —— 路由变化时只有「离开 / 进入」的那一两个 AppLink 会重渲染，
function useIsActivePath(to: string) {
    return useSyncExternalStore(subscribeLocation, () => getPathname() === to)
}

// 应用内导航统一走 navigateTo（navigate + 栈 add），保证每次导航都进栈。
// 取代 NavLink：自维护栈模式下不能用 react-router 的 NavLink 直接跳转，否则会绕过栈，
// 调用方如要叠加自身 onClick，也会被合并后先于导航执行。
export const AppLink = forwardRef<HTMLAnchorElement, AppLinkProps>(
    ({ to, className, children, onClick, ...rest }, ref) => {
        const navigateTo = useNavigateTo()
        const isActive = useIsActivePath(to)
        const cls = typeof className === 'function' ? className({ isActive }) : className
        return (
            <a
                ref={ref}
                href={`#${to}`}
                className={cls}
                onClick={(e) => {
                    e.preventDefault()
                    onClick?.(e)
                    navigateTo(to)
                }}
                {...rest}
            >
                {children}
            </a>
        )
    },
)

AppLink.displayName = 'AppLink'
