/**
 * 构建期注入的常量（由 vite.config.ts 的 define 替换成字面量）。
 */

/** 短 commit hash（7 位）。拿不到时为 'unknown' */
declare const __APP_COMMIT__: string

/** 提交时间，ISO 8601（`git log -1 --format=%cI`）。拿不到时为空串 */
declare const __APP_COMMIT_DATE__: string

/** 仓库 owner，从 electron-builder.yml 的 publish 段读，避免两处配置漂移 */
declare const __APP_REPO_OWNER__: string

/** 仓库名，同上 */
declare const __APP_REPO_NAME__: string
