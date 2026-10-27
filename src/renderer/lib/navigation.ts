import { router } from '@renderer/app/router'
import { useRouteHistoryStore } from '@renderer/store'

/**
 * 程序化导航（React 组件外使用，如插件 IPC 回调中）。
 * 既驱动 react-router 按 path 渲染，又向自维护的路由历史栈追加，保持前进/后退一致。
 * 组件内请优先使用 useNavigateTo hook；本函数用于无法获取 hook 上下文的场景。
 */
export function goTo(path: string): void {
    router.navigate(path).catch()
    const [pathname, search = ''] = path.split('?')
    useRouteHistoryStore.getState().add({
        pathname,
        search: search ? `?${search}` : '',
    })
}
