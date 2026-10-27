// IPC 客户端薄封装
export const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
    window.api.invoke<T>(channel, ...args)

export const invokeResult = <T>(channel: string, ...args: unknown[]): Promise<Result<T>> =>
    window.api.invokeResult<T>(channel, ...args)
