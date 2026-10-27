import { app, net, type BrowserWindow } from 'electron'
import { autoUpdater, type ProgressInfo } from 'electron-updater'
import { LP_EVENT } from '@shared/event'
import { compareVersion } from '@shared/utils'
import { log } from './log'
import { friendlyUpdateError } from './networkError'
import type { AppContext } from './app'

/**
 * 自动更新。
 *
 * 链路：electron-builder 的 publish 配置 → 打进包里的 resources/app-update.yml →
 *       electron-updater 按它去 GitHub Releases 读 latest.yml → 差分下载 → quitAndInstall。
 *
 * 状态真相在这里，渲染端只读（`update:getState` 拿快照，之后订阅两条事件通道）。
 */

/** 进度转发节流 */
const PROGRESS_THROTTLE_MS = 250

/** 拉更新日志的超时。国内 api.github.com 经常慢，别让按钮一直转 */
const CHANGELOG_TIMEOUT_MS = 10000

/** 检查更新的整体超时 */
const CHECK_TIMEOUT_MS = 15000

/** Promise.race 里用来识别「超时」这个分支的哨兵文本，不会和真实错误撞上 */
const CHECK_TIMEOUT_REASON = 'lp:check-timeout'

const REPO =
    typeof __APP_REPO_OWNER__ === 'string' && typeof __APP_REPO_NAME__ === 'string' && __APP_REPO_OWNER__ && __APP_REPO_NAME__
        ? `${__APP_REPO_OWNER__}/${__APP_REPO_NAME__}`
        : null

type StatePatch = Partial<Omit<UpdateState, 'currentVersion'>>

let hostCtx: AppContext | null = null

let current: UpdateState = {
    status: 'idle',
    currentVersion: '',
    latestVersion: null,
    error: null,
    progress: null,
}

/** 最近一次检查拿到的版本说明 —— 更新日志接口不通时用它兜底 */
let latestReleaseNotes: ChangelogEntry | null = null

/** quitAndInstall 已触发 */
let quitting = false

/** 同一时刻只允许一个动词在飞，防连点 */
let inFlight: 'check' | 'download' | null = null

/**
 * 上一次检查已经被超时收尾了。
 *
 * 放弃等待并不代表底层请求停了：它过一会儿仍会 emit('error')，那只是同一个失败的
 * 后半截。不挡住的话「网络超时，请稍后重试」会被 `net::ERR_CONNECTION_TIMED_OUT` 盖回去。
 */
let checkTimedOut = false

/** 底层那次检查（可能仍在飞） */
let pendingCheck: Promise<unknown> | null = null

let lastProgressAt = 0

export function isUpdaterQuitting(): boolean {
    return quitting
}

/** 当前快照。currentVersion 每次现取，避免模块加载时机早于 app ready 时留下空值。 */
export function getUpdateState(): UpdateState {
    return { ...current, currentVersion: app.getVersion() }
}

function getMainWindow(): BrowserWindow | null {
    const win = hostCtx?.mainWindow
    return win && !win.isDestroyed() ? win : null
}

function broadcastState(): void {
    getMainWindow()?.webContents.send(LP_EVENT['UPDATE.STATE'], getUpdateState())
}

function setState(patch: StatePatch): void {
    const next: UpdateState = { ...current, ...patch }
    // 只有 downloading 期间保留进度，其余状态一律清空
    if (next.status !== 'downloading') next.progress = null
    current = next
    broadcastState()
}

function assertPackaged(action: string): void {
    if (!app.isPackaged) throw new Error(`开发模式下不支持${action}（包里没有 app-update.yml）`)
}

function bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
        log.info('[update] 开始检查更新')
        setState({ status: 'checking', error: null })
    })

    autoUpdater.on('update-available', (info) => {
        log.info(`[update] 发现新版本 ${info.version}（当前 ${app.getVersion()}）`)
        latestReleaseNotes = {
            version: info.version,
            date: info.releaseDate ?? '',
            notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
        }
        setState({ status: 'available', latestVersion: info.version, error: null })
    })

    autoUpdater.on('update-not-available', (info) => {
        log.info(`[update] 已是最新版本 ${info.version}`)
        setState({ status: 'not-available', latestVersion: info.version, error: null })
    })

    autoUpdater.on('download-progress', (info: ProgressInfo) => {
        const progress: UpdateProgress = {
            percent: info.percent,
            transferred: info.transferred,
            total: info.total,
            bytesPerSecond: info.bytesPerSecond,
        }
        current = { ...current, progress }

        const now = Date.now()
        if (now - lastProgressAt < PROGRESS_THROTTLE_MS) return
        lastProgressAt = now
        // 进度单独一条通道：高频数值不该拖动整棵关于页重渲染
        getMainWindow()?.webContents.send(LP_EVENT['UPDATE.PROGRESS'], progress)
    })

    autoUpdater.on('update-downloaded', (info) => {
        log.info(`[update] 下载完成 ${info.version}，等待用户重启安装`)
        setState({ status: 'downloaded', latestVersion: info.version })
    })

    autoUpdater.on('error', (err) => {
        // 断网、超时、404、latest.yml 缺失、sha512 不匹配都会走这里
        const reason = err?.message ?? String(err)
        if (checkTimedOut) {
            log.warn('[update] 已按超时收尾，忽略这次迟到的失败：', reason)
            return
        }
        log.error('[update] 失败：', reason)
        // friendlyUpdateError 除空 reason 外恒返回非空，所以不需要再 `|| reason` 把原文兜回来
        setState({ status: 'error', error: friendlyUpdateError(reason, net.isOnline()) || '检查更新失败' })
    })
}

/** 检查更新。失败不抛给调用方：具体原因已由 'error' 事件写进状态。 */
export async function checkForUpdates(): Promise<void> {
    assertPackaged('检查更新')
    if (current.status === 'downloading') throw new Error('正在下载更新，请等待下载结束')
    if (inFlight === 'check') return

    inFlight = 'check'
    checkTimedOut = false
    let timer: ReturnType<typeof setTimeout> | null = null
    try {
        // 底层请求只发起一份：上一次超时后它可能还在飞，重试要接着等它，别再叠一个
        let pending = pendingCheck
        if (pending) {
            // 复用时会拿不到 checking-for-update 事件（electron-updater 直接把旧 promise 还回来），
            // 自己补一个状态，否则按钮点下去毫无反馈
            log.info('[update] 上一次检查仍未结束，重试继续等它')
            setState({ status: 'checking', error: null })
        } else {
            const started = autoUpdater.checkForUpdates()
            pendingCheck = started
            const clear = (): void => {
                pendingCheck = null
            }
            started.then(clear, clear)
            pending = started
        }

        await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(CHECK_TIMEOUT_REASON)), CHECK_TIMEOUT_MS)
            }),
        ])
    } catch (err) {
        const reason = (err as Error)?.message ?? ''

        // 自己掐的表：底层请求可能还在飞，标记一下，让它迟到的失败别再改状态
        if (reason === CHECK_TIMEOUT_REASON) {
            checkTimedOut = true
            log.warn(`[update] 检查更新超过 ${CHECK_TIMEOUT_MS / 1000} 秒，不再等待`)
            setState({ status: 'error', error: '网络超时，请稍后重试' })
            return
        }

        // electron-updater 失败时会同时 reject 和 emit('error')。
        // 事件已经写了更具体的原因，这里只在状态没被改成 error 时兜底，避免重复覆盖。
        if (current.status !== 'error') {
            const raw = reason || '检查更新失败'
            setState({ status: 'error', error: friendlyUpdateError(raw, net.isOnline()) })
        }
    } finally {
        if (timer) clearTimeout(timer)
        inFlight = null
    }
}

/** 下载更新。只在 available 状态可调；失败后要重新检查（electron-updater 不保证 error 态可续传）。 */
export async function downloadUpdate(): Promise<void> {
    assertPackaged('下载更新')
    if (current.status !== 'available') throw new Error('当前没有可下载的更新')
    if (inFlight === 'download') return

    inFlight = 'download'
    // 上一次检查如果按超时收尾了，别让那个标记继续吞掉下载的失败
    checkTimedOut = false
    lastProgressAt = 0
    log.info(`[update] 开始下载 v${current.latestVersion ?? '?'}`)
    setState({ status: 'downloading', error: null })
    try {
        await autoUpdater.downloadUpdate()
    } catch (err) {
        // 取快照而不是读 current
        if (getUpdateState().status !== 'error') {
            const raw = (err as Error)?.message ?? '下载更新失败'
            setState({ status: 'error', error: friendlyUpdateError(raw, net.isOnline()) })
        }
    } finally {
        inFlight = null
    }
}

/** 退出并安装。isSilent=true 静默跑安装器，isForceRunAfter=true 装完自动拉起新版本。 */
export function installUpdate(): void {
    assertPackaged('安装更新')
    if (current.status !== 'downloaded') throw new Error('更新尚未下载完成')

    quitting = true
    log.info('[update] 退出并安装更新')
    autoUpdater.quitAndInstall(true, true)
}

// ============================================================
// 更新日志
// ============================================================

/**
 * 取 `fromVersion` 之后的所有 Release 说明，按版本倒序。
 *
 * 数据源是 releases.atom（网页端的 feed），不是 api.github.com：
 *   API 对未认证请求限制 60 次/小时/IP，用户多点几次「查看变更日志」就会 403。
 *   atom 走 github.com 本身，不占 API 限额，而且和 electron-updater 检查版本用的是同一个源。
 *
 * - `fromVersion` + inclusive=false：返回「fromVersion 之后」的全部变更（首启弹窗用）
 * - inclusive=true：把 fromVersion 自己那条也算进来（手动「查看变更日志」用
 * - 过滤后为空（当前已是最新 / 比 feed 里所有版本都新）：只返回最新一版
 * - 拉取失败：退回 electron-updater 检查时带回的那一版说明；再没有就抛错，由调用方决定弹不弹
 *
 * ⚠️ 代价：feed 只给最近 10 个 release。跨 10 个以上版本时拿不全 —— 实际上不会有人
 *    落后 10 个大版本还来这里看日志；真要补全得回到 API，或者发布时附带一份 changelog 文件。
 */
export async function fetchChangelog(fromVersion: string | null, inclusive = false): Promise<ChangelogEntry[]> {
    if (!REPO) throw new Error('构建时没拿到仓库信息，无法获取更新日志')

    // URL 要进错误文本：friendlyUpdateError 靠 `.atom` 区分「更新源本身不存在」和「源上缺文件」
    const url = `https://github.com/${REPO}/releases.atom`
    let xml: string
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': 'lightplayer' },
            signal: AbortSignal.timeout(CHANGELOG_TIMEOUT_MS),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`)
        xml = await res.text()
    } catch (err) {
        const reason = (err as Error)?.message ?? String(err)
        const friendly = friendlyUpdateError(reason, net.isOnline())
        log.warn(`[update] 拉取更新日志失败（${reason}），尝试用检查时缓存的说明兜底`)
        if (latestReleaseNotes?.notes) return [latestReleaseNotes]
        throw new Error(`获取更新日志失败：${friendly || reason}`)
    }

    const entries = parseReleasesAtom(xml)
    if (entries.length === 0) throw new Error('获取更新日志失败：feed 里没有解析到任何版本')

    const matched = entries.filter((e) => {
        if (!fromVersion) return true
        const d = compareVersion(e.version, fromVersion)
        return inclusive ? d >= 0 : d > 0
    })
    log.info(
        `[update] 更新日志：${matched.length} 个版本 ${inclusive ? '≥' : '>'} ${fromVersion ?? '(全部)'}` +
        `（feed 共 ${entries.length} 条）`,
    )

    return matched.length > 0 ? matched : entries.slice(0, 1)
}

/**
 * 解析 releasesAtom。
 * 每条 `<entry>`：`<id>` 末尾是 tag（v0.1.3）、`<updated>` 是发布时间、
 * `<content type="html">` 是被转义过的 release 正文。
 */
function parseReleasesAtom(xml: string): ChangelogEntry[] {
    const entries: ChangelogEntry[] = []

    for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const block = m[1]
        const id = block.match(/<id>([\s\S]*?)<\/id>/)?.[1] ?? ''
        const updated = block.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] ?? ''
        const content = block.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] ?? ''

        const version = id.trim().split('/').pop()?.replace(/^v/i, '') ?? ''
        if (!version) continue

        entries.push({ version, date: updated.trim(), notes: htmlToPlainText(content) })
    }

    return entries.sort((a, b) => compareVersion(b.version, a.version))
}

/**
 * atom 的 content 是转义过的 HTML。转成 renderNotes 认得的极简 markdown：
 * 标题 → `### `、列表项 → `- `、`<br>` → 换行，其余标签丢掉。
 */
function htmlToPlainText(escaped: string): string {
    const html = escaped
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        // &amp; 必须最后还原，否则 &amp;lt; 会被提前变成 <
        .replace(/&amp;/g, '&')
        // ⚠️ feed 里为了排版，每条 li 内部都有字面换行（不是 <br>）。这些换行没有语义，
        //    先统一压成空格 —— 真正的分行留给下面 li / h / p 的处理，否则一条列表项会被切成几段。
        .replace(/\s*\r?\n\s*/g, ' ')

    return html
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_all, inner: string) => `\n### ${stripTags(inner)}\n`)
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_all, inner: string) => `- ${stripTags(inner)}\n`)
        .replace(/<\/p>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        // 第二轮实体解码：正文里的字面 `<` 在 atom 里是双层转义（&amp;lt;），第一轮只能还原
        // 到 `&lt;`（再往前一步就会被当标签删掉）。标签清完之后再解一次，否则用户会在日志里
        // 看到「%LOCALAPPDATA%&lt;应用名&gt;-updater」这种东西。&nbsp; 统一当空格。
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]{2,}/g, ' ')
        // 行首行尾都清掉：块级标签替换后常残留空格，而 https 里 ` - xxx` 匹配不上
        // renderNotes 的 /^[-*]\s/，会被当成普通段落、丢掉项目符号。
        .replace(/[ \t]*\r?\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

function stripTags(text: string): string {
    return text.replace(/<[^>]+>/g, '').trim()
}

export function initUpdater(appCtx: AppContext): void {
    hostCtx = appCtx

    if (!app.isPackaged) {
        log.info('[update] 开发模式：跳过自动更新（未打包时没有 app-update.yml）')
        return
    }

    // 不自动下载（要不要下载由渲染端按设置决定）。
    // 下载完成之后则由框架兜底：用户点「稍后」就等于「现在不重启，退出时顺手装上」。
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = log

    bindEvents()

    log.info(`[update] 已初始化 v${app.getVersion()}（repo=${REPO ?? '未知'}）`)
}
