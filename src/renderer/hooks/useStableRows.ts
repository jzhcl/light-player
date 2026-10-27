import { useRef } from 'react'

/**
 * 按项缓存构造结果：只有「这一行的输入」变化时它才生成新对象，其余行复用旧对象。
 *
 * 为什么需要它：行数据通常是 `items.map(build)` 产出的，只要数组里有一项变了，
 * map 就会给所有行造出新对象；新对象引用不同 → 行组件的 React.memo 全部失效
 * → 明明只改了一行，却全表重渲染。本 hook 让「未变化的行」保持对象身份不变。
 *
 * 全部命中（没有任何一行需要重建）时连数组本身也复用，这样配合 ListView 的 memo
 * 可以做到：页面因无关状态重渲染时，列表完全不动。
 *
 * @param items    源数据
 * @param getKey   行 key（与 ListView 的 getKey 一致）
 * @param extraOf  该行构造结果依赖的额外输入（如回填的已入库歌曲）。
 *                 它和 item 一起决定这一行要不要重建 —— 漏了它就会用到过期结果。
 * @param build    构造行对象
 */
export function useStableRows<T, R>(
    items: readonly T[],
    getKey: (item: T, index: number) => string,
    extraOf: (item: T, index: number) => unknown,
    build: (item: T, index: number) => R,
): R[] {
    const stateRef = useRef<{
        cache: Map<string, { item: T; extra: unknown; row: R }>
        rows: R[]
    }>({ cache: new Map(), rows: [] })

    const prev = stateRef.current
    const cache = new Map<string, { item: T; extra: unknown; row: R }>()
    let allHit = prev.rows.length === items.length

    const rows = items.map((item, index) => {
        const key = getKey(item, index)
        const extra = extraOf(item, index)
        const hit = prev.cache.get(key)
        if (hit && hit.item === item && hit.extra === extra) {
            // 命中：连缓存条目一起搬过去（身份不变，行组件的 memo 得以生效）
            cache.set(key, hit)
            return hit.row
        }
        allHit = false
        const row = build(item, index)
        cache.set(key, { item, extra, row })
        return row
    })

    if (allHit) return prev.rows
    stateRef.current = { cache, rows }
    return rows
}
