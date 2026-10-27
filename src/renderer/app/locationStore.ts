// 当前路由 pathname 的轻量外部 store。
//
// 设计动机：react-router 的 useLocation() 订阅 LocationContext，任何消费者都会因
// 每次路由变化而重渲染。若让 Navbar / AppLink 各自 useLocation，路由跳转会拖着整棵
// 侧边栏重渲染。这里把「唯一的 useLocation 消费者」收口到 <LocationSync/>，
// 它把 pathname 写进本 store；其余组件经 useSyncExternalStore 读取，从而把
// 「是否当前路由」变成细粒度订阅——路由变化时只有 active 翻转的那一两个消费者重渲染。

// 模块加载时从 URL hash 预读初始 pathname（hash router：#/recent → /recent），
// 让首屏高亮即正确，避免首帧无高亮闪一下。后续由 <LocationSync/> 持续维护。
function initialPathname(): string {
    if (typeof window === 'undefined') return ''
    const raw = window.location.hash.slice(1)
    return raw.split('?')[0] || ''
}

let pathname = initialPathname()

const listeners = new Set<() => void>()

export function subscribeLocation(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
        listeners.delete(cb)
    }
}

export function getPathname(): string {
    return pathname
}

export function setPathname(next: string): void {
    if (next === pathname) return
    pathname = next
    listeners.forEach((cb) => cb())
}
