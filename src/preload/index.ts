import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { isAllowedChannel, isKnownTopic } from '@shared/topic'


contextBridge.exposeInMainWorld('api', {
    invoke: <T>(channel: string, ...args: unknown[]) =>
        ipcRenderer.invoke(channel, ...args) as Promise<T>,

    invokeResult: <T>(channel: string, ...args: unknown[]) =>
        ipcRenderer.invoke(channel, ...args) as Promise<Result<T>>,

    on: (channel: string, cb: (...args: unknown[]) => void) => {
        const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.off(channel, listener)
    },

    once: (channel: string, cb: (...args: unknown[]) => void) => {
        const listener = (_e: unknown, ...args: unknown[]) => cb(...args)
        ipcRenderer.once(channel, listener)
        return () => ipcRenderer.removeListener(channel, listener)
    },

    send: (channel: string, ...args: unknown[]) => {
        ipcRenderer.send(channel, ...args)
    },

    publish: (topic: string, channel: string, ...args: unknown[]) => {
        if (!isAllowedChannel(topic, channel)) {
            throw new Error(`未登记的 topic/channel：${topic} / ${channel}`)
        }
        ipcRenderer.send('message', topic, channel, ...args)
    },

    subscribe: (topic: string, cb: (channel: string, ...args: unknown[]) => void) => {
        if (!isKnownTopic(topic)) throw new Error(`未登记的 topic：${topic}`)
        const listener = (_e: unknown, topic_: unknown, channel: unknown, ...args: unknown[]) => {
            if (topic === topic_ && typeof channel === 'string') cb(channel, ...args)
        }
        ipcRenderer.on('message', listener)
        return () => ipcRenderer.off('message', listener)
    },

    // 浏览器限制：渲染进程无法直接读取 File 的本地路径，需经 webUtils.getPathForFile 转换。
    getFilePath: (file: File) => webUtils.getPathForFile(file),
})

contextBridge.exposeInMainWorld('env', {
    isDev: process.env.NODE_ENV === 'development',
    platform: process.platform as 'darwin' | 'win32' | 'linux',
})
