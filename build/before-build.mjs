/**
 * electron-builder `beforeBuild` 钩子：声明「node_modules 由我自己处理」，即一个都不打包。
 *
 * 为什么需要这个文件（别删，删了 app.asar 立刻从 3.2MB 涨到 32MB）：
 *   electron-builder 复制 node_modules 走的是独立通道，和 `files` 无关：
 *     app-builder-lib/out/util/appFileCopier.js  computeNodeModuleFileSets()
 *   它在 platformPackager.js:369 处受 `areNodeModulesHandledExternally` 门控，
 *   而这个标志位只在 packager.js:482 被赋值 —— 也就是 beforeBuild 返回 false 时。
 *
 * 两条走不通的路（试过，别回头）：
 *   1. `files` 里写 `!node_modules/**` 无效 —— 那个排除项只作用于主遍历，
 *      而 node_modules 根本不经主遍历（主遍历本身就已经硬编码排除了它）。
 *   2. `npmRebuild: false` 无效 —— 它在 beforeBuild 之前就 return（packager.js:471），
 *      标志位永远是 false，node_modules 照旧全量复制。
 *
 * 成立的前提：main / preload / renderer 全部由 vite 打进 dist/，运行时不需要任何裸模块。
 * 将来若真有包必须 external（例如带原生 .node 的依赖），把这里改成 return true，
 * 或者干脆显式 `files: [{ from: "node_modules/<pkg>", to: "node_modules/<pkg>" }]` 白名单。
 */
export default async function beforeBuild() {
    return false
}
