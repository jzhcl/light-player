import { useContext } from 'react'
import { UNSAFE_DataRouterContext } from 'react-router-dom'

/**
 * 取稳定的 router 实例（用于程序化导航）。
 *
 * 背景：v7 data-router 模式下 `useNavigate()` 走 `useNavigateStable → useCurrentRouteId
 * → 订阅 RouteContext`，而 v7 的 _renderMatches 每次导航都给 RouteContext 造新值对象，
 * 于是任何调用 useNavigate() 的组件都会在每次导航时整棵重渲染（React.memo 拦不住——
 * 重渲染来自内部 hook 订阅而非父组件 prop 变化）。
 *
 * DataRouterContext 的值由 RouterProvider 用 useMemo 保持引用不变（router 实例本身也是
 * createHashRouter 返回的长生命周期单例），因此 useContext 它不会因导航而重渲染。
 * 直接拿 router 实例调 router.navigate(to, opts?) 即可，既不被导航触发重渲染，
 * 又不经由 app/router.tsx 引入循环依赖。
 */
export function useRouter() {
    const ctx = useContext(UNSAFE_DataRouterContext)
    if (!ctx) {
        throw new Error('useRouter 必须在 react-router data router 内部使用')
    }
    return ctx.router
}
