import { isFileExists } from '@renderer/lib/file'

/** Fisher–Yates 洗牌，返回新数组。 */
export function shuffle<T>(arr: readonly T[]): T[] {
    const a = arr.slice()
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[a[i], a[j]] = [a[j], a[i]]
    }
    return a
}

/**
 * 验证播放链接是否可用：
 * - 本地路径：检查文件是否存在。
 * - 在线链接：发起 HEAD 请求，以实际响应状态过滤 403/404 等不可用链接；
 *   若服务器不支持 HEAD（405），退化为带 Range 的 GET（仅取状态码，不下载 body）。
 *   任意网络层失败或超时均视为不可用。
 * @returns 链接可用返回 true，否则 false。
 */
/** 判断是否为 http(s) 在线链接（与本地文件路径区分）。 */
export function isNetworkUrl(url: string): boolean {
    return /^https?:\/\//i.test(url)
}

/**
 * 本地绝对路径 → file:// URL。
 * Windows 盘符路径需要三段斜杠（file:///C:/...），POSIX 路径两段即可。
 * 内部对路径做 encodeURI，使含中文/空格等非 ASCII 字符的路径也能被浏览器正确解析。
 */
export function toFileUrl(path: string): string {
    const norm = path.replace(/\\/g, '/')
    const prefix = /^[a-zA-Z]:/.test(norm) ? 'file:///' : 'file://'
    return prefix + encodeURI(norm)
}

/**
 * 播放地址归一化。
 */
export function toPlayableUrl(url: string): string {
    if (isNetworkUrl(url) || /^(file|blob|data):/i.test(url)) return url
    return toFileUrl(url)
}

export async function validateLink(link: string, timeoutMs = 8000): Promise<boolean> {
    if (!link) return false
    if (!isNetworkUrl(link)) return await isFileExists(link)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(link, { method: 'HEAD', signal: controller.signal })
        if (res.ok) return true
        // 405 表示服务器不支持 HEAD，改用带 Range 的 GET（只取状态码，不读取 body）。
        if (res.status === 405) {
            const r2 = await fetch(link, {
                method: 'GET',
                headers: { Range: 'bytes=0-0' },
                signal: controller.signal,
            })
            return r2.status === 200 || r2.status === 206
        }
        return false
    } catch {
        return false
    } finally {
        clearTimeout(timer)
    }
}
