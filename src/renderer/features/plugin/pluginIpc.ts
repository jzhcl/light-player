import { usePluginStore } from '@renderer/store'
import type { OpenViewOutcome } from '@renderer/store/pluginStore'
import { isOk } from '@shared/result'
import { message } from '@renderer/lib/message'
import { LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME } from '@renderer/lib/constants'
import { getAllPlaylists } from '@renderer/lib/db'
import { toFileUrl } from '@renderer/lib/utils'
import { findViewByWindow, pushToFrame, requestFrame, replyToFrame } from './viewBridge'
import {
    sendPluginViewMessage,
    replyPluginViewRequest,
    notifyPluginHostEvent,
} from '@renderer/lib/plugin'
import { goTo } from '@renderer/lib/navigation'
import type { MessageType } from '@renderer/store/messageStore'
import {
    createSongFromPlugin,
    updateSongFromPlugin,
    deleteSong,
    markSongLike,
    unmarkSongLike,
} from '@renderer/features/song/songService'
import { saveSongLyric } from '@renderer/features/lyrics/songLyricService'
import {
    createPlaylist,
    deletePlaylist,
    addSongToPlaylist,
    removeSongFromPlaylist,
} from '@renderer/features/playlist/playlistService'


let initialized = false

/** 最近一次关闭的来源，随 @closed 广播给插件后端；广播后重置为 user */
let lastCloseReason: ViewCloseReason = 'user'

/**
 * 从已聚合的 contributions.views 中解析某个插件的视图（含运行时注入的 container / entryUrl）
 */
function resolveView(pluginId: string, viewId: string): PluginViewContribution | undefined {
    return (usePluginStore.getState().contributions.views as PluginViewContribution[] | undefined)?.find(
        (v) => v.pluginId === pluginId && v.id === viewId,
    )
}

/**
 * 打开视图：按 container 分发。
 * - modal：写入 store.activeView，由 ViewHost 渲染为 Modal 浮层。
 * - settings：路由跳转到 /settings/plugin-settings/:id?view=<viewId>（PluginSettingsView 渲染）。
 * 返回判定结果，供后端 showView 回执（settings 导航成功一律算 opened）。
 */
function showViewResolved(
    pluginId: string,
    viewId: string,
    options?: PluginShowViewOptions,
): OpenViewOutcome {
    const view = resolveView(pluginId, viewId)
    if (!view) {
        return { status: 'rejected', reason: 'unknown-view' }
    }
    if (view.container === 'settings') {
        goTo(`/settings/plugin-settings/${pluginId}?view=${encodeURIComponent(viewId)}`)
        return { status: 'opened' }
    }
    return usePluginStore.getState().openView(pluginId, viewId, options)
}

/** 关闭视图。settings 是路由页，明确拒绝而不是静默无效。 */
function closeViewResolved(
    pluginId: string,
    viewId: string,
    reason: ViewCloseReason,
): CloseViewResult {
    const view = resolveView(pluginId, viewId)
    if (view?.container === 'settings') {
        return { status: 'rejected', reason: 'not-closable' }
    }
    const current = usePluginStore.getState().activeView
    if (!current || current.pluginId !== pluginId || current.viewId !== viewId) {
        return { status: 'rejected', reason: 'not-open' }
    }
    lastCloseReason = reason
    usePluginStore.getState().closeView(pluginId, viewId)
    return { status: 'closed' }
}

/**
 * 注册渲染端对主进程插件推送的监听。
 *
 * 主 → 渲染 `plugin:view`：type = push / request / reply
 * 渲染 → 主 `plugin:viewMessage`：{ kind: 'send' | 'request' }（request 有回执）
 * 渲染 → 主 `plugin:viewReply`：视图对后端 request 的回执
 * 渲染 → 主 `plugin:hostEvent`：宿主事件广播（@opened / @closed）
 */
export function initPluginIpc(): void {
    if (initialized) return
    initialized = true

    window.api.on('plugin:sdk-invoke', (payload) => {
        const { requestId, pluginId, action, args } = (payload as {
            requestId: string
            pluginId: string
            action: string
            args?: unknown[]
        })
        void handleSdkInvoke(requestId, pluginId, action, args ?? [])
    })

    window.api.on('plugin:console', (payload) => {
        const { pluginId, level, args: logArgs, timestamp } = (payload as {
            pluginId: string
            level: string
            args: string[]
            timestamp: number
        })
        usePluginStore.getState().appendConsoleLog({ pluginId, level, args: logArgs, timestamp })
    })

    window.api.on('plugin:message', (payload) => {
        const p = payload as {
            type: MessageType
            pluginId: string
            pluginName: string
            text: string
        }
        const show = message[p.type] ?? message.info
        show(`[${p.pluginName || p.pluginId}] ${p.text}`)
    })

    window.api.on('plugin:view', (payload) => {
        const { type, pluginId, viewId, data } = (payload as {
            type: 'push' | 'request' | 'reply'
            pluginId: string
            viewId: string
            data?: unknown
        })

        if (type === 'push') {
            const p = data as { action?: string; payload?: unknown } | undefined
            if (typeof p?.action === 'string') pushToFrame(pluginId, viewId, p.action, p.payload)
            return
        }

        if (type === 'request') {
            const p = data as { id?: string; action?: string; payload?: unknown } | undefined
            if (typeof p?.id !== 'string' || typeof p?.action !== 'string') return
            const delivered = requestFrame(pluginId, viewId, p.id, p.action, p.payload)
            // 未挂载：立刻让插件的 request 失败，别让它干等 15s 超时
            if (!delivered) void replyPluginViewRequest(p.id, { ok: false, error: '视图未挂载' })
            return
        }

        if (type === 'reply') {
            const p = data as { id?: string; ok?: boolean; data?: unknown; error?: string } | undefined
            if (typeof p?.id !== 'string') return
            void replyPluginViewRequest(p.id, { ok: Boolean(p.ok), data: p.data, error: p.error })
        }
    })

    window.addEventListener('message', (e) => {
        void handleViewWindowMessage(e)
    })

    // 视图生命周期广播：单槽变化 → 通知对应的插件后端（@opened / @closed）
    usePluginStore.subscribe((state, prev) => {
        const next = state.activeView
        const last = prev.activeView
        if (next === last) return
        if (last) {
            void notifyPluginHostEvent(last.pluginId, '@closed', {
                viewId: last.viewId,
                reason: lastCloseReason,
            })
            lastCloseReason = 'user'
        }
        if (next) {
            void notifyPluginHostEvent(next.pluginId, '@opened', { viewId: next.viewId })
        }
    })
}

/** 视图 iframe 发来的消息（lp:*） */
async function handleViewWindowMessage(e: MessageEvent): Promise<void> {
    const d = e.data as Record<string, unknown> | undefined
    if (!d || typeof d !== 'object' || typeof d.type !== 'string') return
    if (!d.type.startsWith('lp:')) return

    // 来源由 event.source 反查，不信 payload 里的 pluginId / viewId
    const source = findViewByWindow(e.source)
    if (!source) return

    if (d.type === 'lp:send') {
        if (typeof d.action !== 'string') return
        void sendPluginViewMessage(source.pluginId, source.viewId, {
            kind: 'send',
            action: d.action,
            payload: d.payload,
        })
        return
    }

    if (d.type === 'lp:request') {
        if (typeof d.id !== 'string' || typeof d.action !== 'string') return
        const id = d.id
        const action = d.action

        // 宿主保留动作（视图不需要经过插件后端）
        if (action === '@open') {
            const p = d.payload as { viewId?: string; options?: PluginShowViewOptions } | undefined
            const result: ShowViewResult =
                typeof p?.viewId === 'string'
                    ? showViewResolved(source.pluginId, p.viewId, p.options)
                    : { status: 'rejected', reason: 'unknown-view' }
            replyToFrame(source.pluginId, source.viewId, id, true, result)
            return
        }
        if (action === '@close') {
            const result = closeViewResolved(source.pluginId, source.viewId, 'view')
            replyToFrame(source.pluginId, source.viewId, id, true, result)
            return
        }

        const reply = await sendPluginViewMessage(source.pluginId, source.viewId, {
            kind: 'request',
            id,
            action,
            payload: d.payload,
        })
        replyToFrame(
            source.pluginId,
            source.viewId,
            id,
            Boolean(reply?.ok),
            reply?.data,
            reply?.error,
        )
        return
    }

    if (d.type === 'lp:reply') {
        if (typeof d.id !== 'string') return
        void replyPluginViewRequest(d.id, {
            ok: Boolean(d.ok),
            data: d.data,
            error: typeof d.error === 'string' ? d.error : undefined,
        })
        return
    }

    if (d.type === 'lp:close') {
        closeViewResolved(source.pluginId, source.viewId, 'view')
    }
}

/** 插件可见的歌单列表：内置「我喜欢」 */
function toPluginPlaylists(rows: LP.Playlist[]): LP.Plugin.PlaylistInfo[] {
    return [
        { id: LIKED_PLAYLIST_ID, name: LIKED_PLAYLIST_NAME, pluginId: 'local' },
        ...rows.filter((p) => p.id !== LIKED_PLAYLIST_ID).map(toPluginPlaylist),
    ]
}

/** 把封面收敛成可直接渲染的 URL（本地副本优先，与 `Cover` 取图同序） */
function toPluginPlaylist(p: LP.Playlist): LP.Plugin.PlaylistInfo {
    const pic = typeof p.pic === 'string' ? p.pic : p.pic?.path ? toFileUrl(p.pic.path) : p.pic?.url
    return { ...p, pic: pic || undefined }
}

async function handleSdkInvoke(
    requestId: string,
    pluginId: string,
    action: string,
    args: unknown[],
): Promise<void> {
    let result: unknown
    let error: string | undefined
    try {
        switch (action) {
            // ---- 视图生命周期（有回执，供 lp.ui.showView / closeView 的 Promise）----
            case 'view:show': {
                result = showViewResolved(
                    pluginId,
                    args[0] as string,
                    args[1] as PluginShowViewOptions | undefined,
                )
                break
            }
            case 'view:close': {
                result = closeViewResolved(pluginId, args[0] as string, 'api')
                break
            }
            case 'song:create': {
                const created = await createSongFromPlugin(args[0] as LP.Plugin.Song)
                if (!isOk(created)) error = created.error
                else result = created.value.id
                break
            }
            case 'song:update': {
                const r = await updateSongFromPlugin(
                    args[0] as string,
                    args[1] as Partial<LP.Plugin.Song>,
                )
                if (!isOk(r)) error = r.error
                else result = true
                break
            }
            case 'song:delete': {
                result = await deleteSong(args[0] as string)
                break
            }
            case 'lyric:update': {
                const r = await saveSongLyric(
                    args[0] as string,
                    args[1] as Partial<LP.SongLyric>,
                )
                if (!isOk(r)) error = r.error
                else result = true
                break
            }
            case 'playlist:create': {
                const data = args[0] as LP.Plugin.Playlist
                const id = `${data.pluginId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
                const r = await createPlaylist({ ...data, id } as Omit<LP.Playlist, 'createdAt' | 'updatedAt'>)
                if (!isOk(r)) error = r.error
                else result = { id: r.value }
                break
            }
            case 'playlist:delete': {
                const r = await deletePlaylist(args[0] as string)
                if (!isOk(r)) error = r.error
                else result = true
                break
            }
            case 'playlist:getAll': {
                const r = await getAllPlaylists()
                if (!isOk(r)) error = r.error
                else result = toPluginPlaylists(r.value)
                break
            }
            case 'playlist:addSong': {
                const playlistId = args[0] as string
                const songId = args[1] as string
                const r =
                    playlistId === LIKED_PLAYLIST_ID
                        ? await markSongLike(songId)
                        : await addSongToPlaylist(playlistId, songId)
                if (!isOk(r)) error = r.error
                else result = true
                break
            }
            case 'playlist:removeSong': {
                const playlistId = args[0] as string
                const songId = args[1] as string
                if (playlistId === LIKED_PLAYLIST_ID) {
                    const r = await unmarkSongLike(songId)
                    if (!isOk(r)) error = r.error
                    else result = true
                } else {
                    const r = await removeSongFromPlaylist(playlistId, songId)
                    if (!isOk(r)) error = r.error
                    else result = true
                }
                break
            }
            default:
                error = `不支持的渲染进程调用动作: ${action}`
        }
    } catch (e) {
        error = e instanceof Error ? e.message : String(e)
    }
    await window.api.invoke('plugin:sdk-invoke-reply', { requestId, result, error })
}
