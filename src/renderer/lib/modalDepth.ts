/**
 * Modal 层级号（z-index depth）
 * ------------------------------------------------------------------
 * 「谁在上面」由打开顺序决定，不由组件在 React 树里的位置决定。
 *
 * 两个域：
 *   - plugin 层：固定 depth 0（所有插件共享，永远是底层）
 *   - app 层：depth 从 1 开始递增（程序内部对话框，后打开的在上）
 *
 * z-index = 基准 + 2 × depth，乘 2 是为了让每一层的遮罩只压住它下面的层
 * （plugin: mask 1050 / wrap 1051；app1: 1052 / 1053；app2: 1054 / 1055）。
 */


const pool: number[] = []
let next = 1

/** 取一个层级号（打开时调用）；有回收池，优先复用小号 */
export function acquireModalDepth(): number {
    return pool.length > 0 ? (pool.shift() as number) : next++
}

/** 归还层级号（关闭时调用）；depth 0 属于 plugin 层，不参与回收 */
export function releaseModalDepth(depth: number): void {
    if (depth <= 0) return
    if (pool.includes(depth)) return
    pool.push(depth)
    pool.sort((a, b) => a - b)
}
