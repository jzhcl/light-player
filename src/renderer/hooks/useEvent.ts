import { useEffect, useRef } from 'react'
import { eventBus } from '@renderer/lib/eventBus'


/**
 * 在组件中订阅渲染端事件。
 * 组件卸载时由 useEffect 自动退订。
 *
 * @example
 * useEvent(LP_EVENT['SONG.UPDATED'], ({ id, patch }) => mergeLocal(id, patch as Partial<LP.Song>))
 */
export function useEvent(channel: string, handler: (...args: unknown[]) => void): void {
    const ref = useRef(handler)
    ref.current = handler
    useEffect(() => eventBus.on(channel, (...args) => ref.current(...args)), [channel])
}
