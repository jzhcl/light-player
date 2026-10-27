import { ipcMain, type BrowserWindow } from 'electron'
import { isAllowedChannel, type Topic } from '@shared/topic'

/**
 * 跨渲染窗消息中转（topic 层）。
 */

/** topic → 目标窗口 */
const topicWindows = new Map<string, BrowserWindow>()

/** 登记某个 topic 的目标窗口。 */
export function registerTopicWindow(topic: Topic, win: BrowserWindow): void {
    topicWindows.set(topic, win)
}

/** 注销 topic（窗口销毁时） */
export function unregisterTopicWindow(topic: Topic): void {
    topicWindows.delete(topic)
}

/** 按 topic 投递一条消息 */
export function publishToTopic(topic: Topic, channel: string, ...args: unknown[]): void {
    if (!isAllowedChannel(topic, channel)) return

    const target = topicWindows.get(topic)
    if (!target || target.isDestroyed()) return

    target.webContents.send('message', topic, channel, ...args)
}

/**
 * 注册 `message` 转发 handler。
 */
export function registerMessageHandlers(): void {
    ipcMain.on('message', (_event, topic: unknown, channel: unknown, ...args: unknown[]) => {
        if (typeof topic !== 'string' || typeof channel !== 'string') return
        publishToTopic(topic as Topic, channel, ...args)
    })
}
