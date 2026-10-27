/**
 * 浮层「失焦即关」的兜底判定。
 *
 * 适用场景：调试浮层（如 Select、Dropdown）时，一旦点击开发者工具或切换到其他窗口，
 * 浮层会因窗口失焦而自动关闭，导致 DOM 和样式无法检查。
 *
 * 用法：把浮层 Root 改成受控，在 `onOpenChange(false)` 时先过本函数：
 *       if (!next && isBlurDismiss()) return   // 拦下失焦导致的关闭
 * 窗口已失焦时用户不可能在本窗口内产生「关闭」意图，故该判定不会误伤真实操作。
 */
export function isBlurDismiss(): boolean {
    return !document.hasFocus()
}
