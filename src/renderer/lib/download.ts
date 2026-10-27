import { invokeResult } from './ipc'

/**
 * 下载网络图片并写入指定的路径。
 * 成功返回 true，失败（网络错误等）返回 false。
 */
export async function downloadImage(url: string, savePath: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('download:downloadImage', url, savePath)
}

/**
 * 从图片 URL 推断文件扩展名（取 URL 文件名后缀，忽略 ?# 查询/锚点），失败回退 jpg。
 */
export function imageExtFromUrl(url: string): string {
    const m = url.match(/[^/\\]+\.([^.\/?#]+)(?:[?#]|$)/i)
    return m ? m[1].toLowerCase() : 'jpg'
}
