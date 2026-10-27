import { useCallback, useRef } from 'react'

/**
 * 行选择交互：
 *  - 普通点击：单选该行
 *  - ctrl / meta 点击：切换该行（仅 multi）
 *  - shift 点击：以上次选中行为锚点的区间连选（仅 multi）
 *  - Ctrl+A：全选（仅 multi）；点击列表空白 / ESC：清空
 *  - single 模式下 ctrl / shift 一律降级为普通点击
 */

/**
 * 选择模式：
 *  - `'single'` 单选
 *  - `'multi'`  多选
 */
export type SelectionMode = 'single' | 'multi'

export interface UseRowSelectionOptions {
    /** 当前可见行的 key 顺序（区间连选与全选的依据） */
    rowKeys: readonly string[]
    /** 受控选中集 */
    selection: ReadonlySet<string>
    /** 选择模式 */
    mode: SelectionMode
    /** 回抛新选中集与「最后操作的行 key」（锚点），供外部做后续动作 */
    onChange: (next: Set<string>, last: string | null) => void
}

export interface RowSelectionApi {
    handleRowClick: (index: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void
    /** 全选（语义上仅多选模式成立，调用方需自行按 mode 把关） */
    selectAll: () => void
    clear: () => void
    /** 右键菜单打开前调用：行不在选区时先把选区收敛到该行，并记下「右键行」 */
    prepareContextMenu: (index: number) => void
    /** 最近一次右键的行 key；选区清空后归 null。读的是 ref，取当前值请用本函数 */
    getContextKey: () => string | null
}

export function useRowSelection({ rowKeys, selection, mode, onChange }: UseRowSelectionOptions): RowSelectionApi {
    /** 区间连选的锚点（= 上次操作的行 key），即对外回抛的 last */
    const anchorRef = useRef<string | null>(null)
    /** 最近一次右键的行 key */
    const contextKeyRef = useRef<string | null>(null)

    const rowKeysRef = useRef(rowKeys)
    rowKeysRef.current = rowKeys
    const selectionRef = useRef(selection)
    selectionRef.current = selection

    const handleRowClick = useCallback(
        (index: number, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
            const keys = rowKeysRef.current
            const key = keys[index]
            if (key === undefined) return

            // 单选模式：修饰键一律降级为普通点击 —— 单击即选中该行，且只选中该行
            if (mode === 'single') {
                anchorRef.current = key
                onChange(new Set([key]), key)
                return
            }

            if (event.shiftKey) {
                // 区间连选：锚点缺失时从第一行连到当前行
                const anchorIndex = anchorRef.current ? keys.indexOf(anchorRef.current) : -1
                const start = anchorIndex === -1 ? 0 : Math.min(anchorIndex, index)
                const end = anchorIndex === -1 ? index : Math.max(anchorIndex, index)
                const next = new Set<string>()
                for (let i = start; i <= end; i++) {
                    const k = keys[i]
                    if (k !== undefined) next.add(k)
                }
                if (anchorRef.current === null) anchorRef.current = key
                onChange(next, anchorRef.current)
                return
            }

            if (event.ctrlKey || event.metaKey) {
                const next = new Set(selectionRef.current)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                anchorRef.current = key
                onChange(next, key)
                return
            }

            anchorRef.current = key
            onChange(new Set([key]), key)
        },
        [mode, onChange],
    )

    const selectAll = useCallback(() => {
        onChange(new Set(rowKeysRef.current), anchorRef.current)
    }, [onChange])

    const clear = useCallback(() => {
        anchorRef.current = null
        // 选区都没了，「右键行」也失去意义（否则换关键词后会残留一个指向已卸载行的 key）
        contextKeyRef.current = null
        onChange(new Set(), null)
    }, [onChange])

    const prepareContextMenu = useCallback(
        (index: number) => {
            const key = rowKeysRef.current[index]
            if (key === undefined) return
            // 无论该行是否已在选区（在选区时不改选区、也不动锚点），都记下右键行
            contextKeyRef.current = key
            if (selectionRef.current.has(key)) return
            anchorRef.current = key
            onChange(new Set([key]), key)
        },
        [onChange],
    )

    const getContextKey = useCallback(() => contextKeyRef.current, [])

    return { handleRowClick, selectAll, clear, prepareContextMenu, getContextKey }
}
