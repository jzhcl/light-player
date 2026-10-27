import { useEffect, useState } from 'react'

const guarded = new Set<HTMLElement>()
let nativeFocus: ((this: HTMLElement, options?: FocusOptions) => void) | null = null
let holders = 0

function isInsideGuarded(el: Element | null): boolean {
    for (let n = el; n; n = n.parentElement) {
        if (guarded.has(n as HTMLElement)) return true
    }
    return false
}

function installGuard() {
    if (holders++ > 0) return
    nativeFocus = HTMLElement.prototype.focus
    HTMLElement.prototype.focus = function (this: HTMLElement, options?: FocusOptions) {
        if (nativeFocus && isInsideGuarded(this)) {
            return nativeFocus.call(this, { ...(options ?? {}), preventScroll: true })
        }
        return nativeFocus?.call(this, options)
    }
}

function releaseGuard() {
    holders = Math.max(0, holders - 1)
    if (holders === 0 && nativeFocus) {
        HTMLElement.prototype.focus = nativeFocus
        nativeFocus = null
    }
}

/**
 * 键盘导航时让聚焦项以「最小位移」进入视野。
 *   1. `focus({ preventScroll: true })` —— 掐掉浏览器自带的「不可见则居中」；
 *   2. `scrollIntoView({ block: 'nearest' })` —— 剩下的位移交给浏览器算。
 *
 * @returns ref 回调，挂到滚动容器
 */
export function useNearestFocusScroll<T extends HTMLElement>(): (node: T | null) => void {
    const [node, setNode] = useState<T | null>(null)

    useEffect(() => {
        if (!node) return
        guarded.add(node)
        installGuard()

        const onFocusIn = (e: FocusEvent) => {
            const target = e.target
            if (!(target instanceof HTMLElement)) return
            let item: HTMLElement | null = target
            while (item && item.parentElement !== node) item = item.parentElement
            if (!item) return
            item.scrollIntoView({ block: 'nearest' })
        }

        node.addEventListener('focusin', onFocusIn)
        return () => {
            node.removeEventListener('focusin', onFocusIn)
            guarded.delete(node)
            releaseGuard()
        }
    }, [node])

    return setNode
}
