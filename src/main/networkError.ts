/**
 * 把主进程里各种「网络出问题」的原始错误翻成面向用户的形式。
 */

/** 断网 / 解析不了域名 / 根本连不上 */
const OFFLINE =
    /ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_ADDRESS_UNREACHABLE|ERR_PROXY_CONNECTION_FAILED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|ECONNREFUSED/i

/** 连上了但半路被断开（对端重置、网络切走、连接被关） */
const INTERRUPTED =
    /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_NETWORK_CHANGED|ECONNRESET|EPIPE/i

/** 等不到回应 */
const TIMEOUT =
    /ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ETIMEDOUT|timed\s?out|aborted due to timeout|TimeoutError/i

/** electron-updater / builder-util-runtime 的 HttpError：`HttpError: 404 Not Found`、`status code 503` */
const HTTP_STATUS = /(?:HttpError|HTTP|status(?:Code)?)\D{0,4}(\d{3})/i

/**
 * HttpError 的 message 首字符就是状态码。
 *
 * builder-util-runtime 拼的是 `${statusCode} ${statusMessage}\n<description>\nHeaders: {...}`，
 * 前面没有任何前缀，上面的 `HTTP_STATUS` 认不出它 → 整段（含响应头里的 cookie）原样透传到界面。
 * 只认 4xx / 5xx：网络错误里不会出现 1xx/2xx/3xx，这样不会把行首的普通数字当状态码。
 */
const BARE_STATUS = /^\s*([45]\d{2})\b/

/** 检查更新拿最新 tag 走的是 `${repo}/releases.atom`，它 404 = 仓库本身不存在 / 无权访问 */
const FEED_URL = /\.atom\b/i

/** 仓库存在但一个 release 都没有时 electron-updater 的原话 */
const NO_RELEASE = /No published versions on GitHub/i

const CHECKSUM = /sha512|checksum|integrity/i

/**
 * @param reason 原始错误文本（`err.message`）
 * @param online `net.isOnline()` 的结果。认不出的错误靠它兜底判断「是不是根本没网」
 * @returns 一句面向用户的中文；认不出的给「首行 + 截断」的原文摘要。
 *          除 `reason` 本身为空外恒返回非空，调用方可以无条件使用。
 */
export function friendlyUpdateError(reason: string, online = true): string {
    if (!reason) return ''

    if (TIMEOUT.test(reason)) return '网络超时，请稍后重试'
    if (INTERRUPTED.test(reason)) return '网络连接中断，请重试'
    if (OFFLINE.test(reason) || !online) return '当前无网络连接，请检查网络后重试'

    // fetch 的失败被包成一句 `fetch failed`，真正的原因在 cause 里、拿不到
    if (/fetch failed/i.test(reason)) return '网络异常，请稍后重试'

    const status = reason.match(HTTP_STATUS)?.[1] ?? reason.match(BARE_STATUS)?.[1]
    if (status) {
        const code = Number(status)
        if (code === 404) {
            // 两种 404 要分开说：出错的是 atom feed = 更新源本身不存在
            // （仓库没建 / 私有且无 token / 一个 release 都没有）；
            // 出错的是 latest.yml 或安装包 = 源在，但文件没传全。
            return FEED_URL.test(reason)
                ? '更新源不可用（HTTP 404）：仓库不存在、无发布版本或无权访问'
                : '更新源上找不到更新文件（HTTP 404），可能还没上传完整'
        }
        if (code === 403) return '请求被更新源拒绝（HTTP 403），请稍后再试'
        if (code >= 500) return `更新源暂时不可用（HTTP ${code}），请稍后重试`
        return `更新源返回异常（HTTP ${code}）`
    }

    if (NO_RELEASE.test(reason)) return '更新源上还没有发布任何版本'

    if (CHECKSUM.test(reason)) return '安装包校验失败，请重新下载'

    return briefError(reason)
}

/**
 * 认不出来的错误只保留一行摘要。
 *
 * 直接透传 `err.message` 会把整段响应头搬上界面。
 * 完整原文由调用方写进日志，这里只负责「人能读」。
 */
function briefError(reason: string): string {
    const first = reason.split(/\r?\n/, 1)[0].trim()
    if (!first) return ''
    return first.length > 120 ? `${first.slice(0, 120)}…` : first
}
