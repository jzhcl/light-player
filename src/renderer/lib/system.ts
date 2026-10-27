import { invoke } from './ipc'

/** 使用系统默认浏览器打开外部链接 */
export const openExternal = (url: string): Promise<void> =>
    invoke<void>('app:openExternal', url)
