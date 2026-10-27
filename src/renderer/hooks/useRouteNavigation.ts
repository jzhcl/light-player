import { useCallback } from 'react'
import { useRouter } from '@renderer/app/useRouter'
import { useRouteHistoryStore } from '@renderer/store'

/**
 * 栈驱动导航：后退/前进的目标取自自维护栈，而不是 navigate(-1)/(1) 这类浏览器历史 delta。
 *
 * 为什么必须如此：History API 无法删除中间某条历史记录，删除歌单后 /playlist/:id 在真实
 * 历史里仍然存在。改为按栈内目标导航后，被 remove 清掉的记录永远不可达。
 *
 * back/forward 只移动指针并返回目标路径，再由 router 按 path 渲染（replace 不新增历史）。
 */
export function useRouteNavigation() {
    const router = useRouter()
    const pointer = useRouteHistoryStore((s) => s.pointer)
    const stackLen = useRouteHistoryStore((s) => s.stack.length)

    const back = useCallback(() => {
        const target = useRouteHistoryStore.getState().back()
        if (target) void router.navigate(target, { replace: true })
    }, [router])

    const forward = useCallback(() => {
        const target = useRouteHistoryStore.getState().forward()
        if (target) void router.navigate(target, { replace: true })
    }, [router])

    return {
        canGoBack: pointer > 0,
        canGoForward: pointer >= 0 && pointer < stackLen - 1,
        back,
        forward,
    }
}
