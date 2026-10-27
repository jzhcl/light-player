import { create } from 'zustand'

// 自维护路由栈

const MAX_STACK_SIZE = 50

interface RouteRecord {
    pathname: string
    search: string
}

interface RouteHistoryState {
    stack: RouteRecord[]
    pointer: number
    /** 首次挂载播种当前路由（仅一次），之后完全自维护 */
    seed: (location: { pathname: string; search: string }) => void
    /** 前向导航：截断前进栈、追加记录；连续相同路径不重复入栈 */
    add: (record: RouteRecord) => void
    /** 后退：指针 -1，返回目标路径（含 search）；不可退则返回 null */
    back: () => string | null
    /** 前进：指针 +1，返回目标路径；不可进则返回 null */
    forward: () => string | null
    /** 设置指针（不导航），越界夹取 */
    setPointer: (index: number) => void
    /** 按谓词移除记录并塌缩相邻重复；指针按索引调整，保证落在有效记录上 */
    remove: (predicate: (record: RouteRecord) => boolean) => void
}

export const useRouteHistoryStore = create<RouteHistoryState>((set, get) => ({
    stack: [],
    pointer: -1,

    seed: (location) =>
        set((s) => {
            if (s.stack.length > 0) return s
            return {
                stack: [{ pathname: location.pathname, search: location.search }],
                pointer: 0,
            }
        }),

    add: (record) =>
        set((s) => {
            // 截断当前位置之后的前进栈
            const stack = s.stack.slice(0, s.pointer + 1)
            let pointer = stack.length - 1
            // 连续相同路径不入栈，避免 A→A 这种无意义跳转污染历史
            const current = stack[pointer]
            if (current && current.pathname === record.pathname && current.search === record.search) {
                return s
            }
            stack.push(record)
            pointer = stack.length - 1
            if (stack.length > MAX_STACK_SIZE) {
                stack.shift()
                pointer--
            }
            return { stack, pointer }
        }),

    back: () => {
        const s = get()
        if (s.pointer <= 0) return null
        const target = s.stack[s.pointer - 1]
        set({ pointer: s.pointer - 1 })
        return target.pathname + target.search
    },

    forward: () => {
        const s = get()
        if (s.pointer >= s.stack.length - 1) return null
        const target = s.stack[s.pointer + 1]
        set({ pointer: s.pointer + 1 })
        return target.pathname + target.search
    },

    setPointer: (index) =>
        set((s) => ({
            pointer: s.stack.length === 0
                ? -1
                : Math.max(0, Math.min(s.stack.length - 1, index)),
        })),

    remove: (predicate) =>
        set((s) => {
            let newPointer = s.pointer
            const newStack: RouteRecord[] = []
            s.stack.forEach((r, i) => {
                if (predicate(r)) {
                    if (i < s.pointer) newPointer--
                    return
                }
                newStack.push(r)
            })

            // 塌缩相邻重复（同 pathname+search 连续记录合并为一条）。
            // 仅合并相邻而非全局：A->B->A 删 B 后才相邻、此时才塌缩，避免误并历史分叉。
            const deduped: RouteRecord[] = []
            if (newStack.length > 0) {
                deduped.push(newStack[0])
                let last = newStack[0]
                for (let i = 1; i < newStack.length; i++) {
                    const cur = newStack[i]
                    if (cur.pathname !== last.pathname || cur.search !== last.search) {
                        deduped.push(cur)
                        last = cur
                    } else if (i <= newPointer) {
                        // 重复且位于指针之前：塌缩时指针同步前移
                        newPointer--
                    }
                }
            }

            const pointer = Math.max(0, Math.min(newPointer, deduped.length - 1))
            return { stack: deduped, pointer }
        }),
}))
