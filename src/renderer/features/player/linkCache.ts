import { LRUCache } from 'lru-cache'

/**
 * 在线播放链接的内存缓存。
 *
 * 为什么需要：主流平台的播放链接大多都是临时生成、带有效期的（通常几十分钟），落库缓存没有意义
 * （库里的链接过一会儿就是死链）；但同一首歌在会话内反复播放/切来切去时，重新取一次链接
 * 要付「插件调用 + 一次 HEAD 校验」两次网络往返。
 *
 * 取向：
 * - 键 `${songId}:${quality}`，值就是 URL；TTL 30 分钟、上限 500 条。
 * - **命中即信任、不再校验** —— 这正是设 TTL 的意义，否则每次播放仍有一次最长 8s 的 HEAD。
 * - 链接可能提前失效（服务端撤销）：播放失败时由 `invalidateLink()` 剔除，下次重取。
 */
const cache = new LRUCache<string, string>({
    max: 500,
    ttl: 30 * 60 * 1000
})

const key = (songId: string, quality: Quality): string => `${songId}:${quality}`

/** 取缓存的播放链接（过期/未命中返回 undefined）。 */
export function getCachedLink(songId: string, quality: Quality): string | undefined {
    return cache.get(key(songId, quality))
}

/** 记下刚取到的播放链接。 */
export function setCachedLink(songId: string, quality: Quality, url: string): void {
    cache.set(key(songId, quality), url)
}

/**
 * 剔除缓存：给了 `quality` 只删那一档；不给则删该歌曲的所有音质。
 * 两个调用点：播放失败（链接提前失效）、删除歌曲（不留无用条目）。
 */
export function invalidateLink(songId: string, quality?: Quality): void {
    if (quality) {
        cache.delete(key(songId, quality))
        return
    }
    const prefix = `${songId}:`
    for (const k of cache.keys()) {
        if (k.startsWith(prefix)) cache.delete(k)
    }
}
