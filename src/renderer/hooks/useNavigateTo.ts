import { useCallback } from 'react'
import { useRouter } from '@renderer/app/useRouter'
import { useRouteHistoryStore } from '@renderer/store'

/**
 * 应用内导航：既驱动 react-router 按 path 渲染、又向自维护路由栈追加。
 * 所有「新导航」都应经此，禁止直接 useNavigate 跳转（会订阅 RouteContext 导致整棵重渲染）。
 */
export function useNavigateTo() {
    const router = useRouter()
    return useCallback(
        (path: string) => {
            void router.navigate(path)
            const [pathname, search = ''] = path.split('?')
            useRouteHistoryStore.getState().add({
                pathname,
                search: search ? `?${search}` : '',
            })
        },
        [router],
    )
}
