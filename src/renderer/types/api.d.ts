declare global {
    interface Window {
        api: {
            /** 裸值，永远成功（isFileExist/window/log/plugin:invoke 等）。 */
            invoke: <T = unknown>(channel: string, ...args: unknown[]) => Promise<T>

            /** Result 包装，可能失败（fileIO/DB/parseAudioMetadata 等）。 */
            invokeResult: <T = unknown>(channel: string, ...args: unknown[]) => Promise<Result<T>>

            /** 订阅主进程->渲染进程的推送。返回取消订阅函数。 */
            on: (channel: string, cb: (...args: unknown[]) => void) => () => void

            /** 订阅一次性推送（触发后自动移除）。返回取消订阅函数。 */
            once: (channel: string, cb: (...args: unknown[]) => void) => () => void

            /** 渲染进程->主进程单向发送。 */
            send: (channel: string, ...args: unknown[]) => void

            /**
             * 跨渲染窗消息（topic 层）：主窗 ↔ 歌词窗，经主进程转发。
             * fire-and-forget，目标窗口不在时消息被静默丢弃。
             */
            publish: (topic: string, channel: string, ...args: unknown[]) => void

            /** 订阅本窗收到的跨窗消息。返回取消订阅函数。 */
            subscribe: (
                topic: string,
                cb: (channel: string, ...args: unknown[]) => void,
            ) => () => void

            /**
             * 获取渲染端 File 对象对应的本地文件路径。
             * 浏览器限制下渲染进程无法直接读取文件路径，需经 preload 的 webUtils.getFilePath 实现。
             */
            getFilePath: (file: File) => string
        }

        /** 运行环境信息 */
        env: {
            /** 是否为开发模式 */
            isDev: boolean
            /** 当前平台 */
            platform: 'darwin' | 'win32' | 'linux'
        }
    }
}

export {}