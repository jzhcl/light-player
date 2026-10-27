import vm from 'node:vm'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { log } from '@main/log'
import type { LpSdk } from './sdk'

const SANDBOX_TIMEOUT = 10_000

/**
 * 创建插件沙箱上下文。
 * 白名单内的全局对象会注入到沙箱中，插件只能通过这些对象与外界交互。
 * @param pluginId 插件标识，用于日志与上下文命名
 * @param sdk 注入的 lp 命名空间对象
 * @param forwardConsole 日志转发回调
 */
export function createSandbox(
    pluginId: string,
    sdk: LpSdk,
    forwardConsole: (level: string, args: unknown[]) => void
): vm.Context {
    // 为插件创建代理 console：插件内 console.log / console.debug 等统一转发到宿主
    const consoleProxy = {
        log: (...args: unknown[]) => forwardConsole('log', args),
        info: (...args: unknown[]) => forwardConsole('info', args),
        warn: (...args: unknown[]) => forwardConsole('warn', args),
        error: (...args: unknown[]) => forwardConsole('error', args),
        debug: (...args: unknown[]) => forwardConsole('debug', args),
    }

    const sandbox: Record<string, unknown> = {
        lp: sdk,
        console: consoleProxy,
        setTimeout,
        setInterval,
        clearTimeout,
        clearInterval,
        Promise,
        JSON,
        URL,
        URLSearchParams,
        Buffer,
        encodeURIComponent,
        decodeURIComponent,
        encodeURI,
        decodeURI,
        btoa,
        atob,
        // Node.js 加密与压缩
        crypto,
        zlib,
        Uint8Array,
        Int32Array,
        ArrayBuffer,
        DataView,
        performance,
        TextEncoder,
        TextDecoder,
        fetch,
        // CommonJS 导出支持
        module: { exports: {} as Record<string, unknown> },
        exports: {} as Record<string, unknown>,
    }

    // module.exports 和 exports 指向同一对象（CommonJS 约定）
    sandbox.exports = (sandbox.module as { exports: Record<string, unknown> }).exports

    return vm.createContext(sandbox, {
        name: `plugin:${pluginId}`,
    })
}

/**
 * 在沙箱中执行插件代码并返回 module.exports。
 * 超时 10 秒后抛出异常。
 */
export function runInSandbox(context: vm.Context, code: string, pluginId: string): Record<string, unknown> {
    const script = new vm.Script(code, {
        filename: `${pluginId}/main.js`,
    })
    try {
        script.runInContext(context, { timeout: SANDBOX_TIMEOUT })
    } catch (e) {
        // 超时单独记一笔：它说明插件里有死循环或长阻塞，而抛出的原始 message
        // （Script execution timed out.）看不出是哪个插件、限时多少。其余错误交给调用方记。
        if ((e as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
            log.error(`[plugin] ${pluginId} 执行超时（${SANDBOX_TIMEOUT}ms），可能存在死循环`)
        }
        throw e
    }
    return (context.module as { exports: Record<string, unknown> }).exports
}
