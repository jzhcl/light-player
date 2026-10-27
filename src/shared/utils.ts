import { formatPath } from './format'

/**
 * 生成唯一ID
 *
 * 结合时间戳、随机数和前缀生成一个高概率唯一的ID
 *
 * @param {string} [prefix = 'id'] ID前缀
 * @param {number} [length = 6] 随机字符串长度
 * @returns {string} 生成的唯一ID
 */
export function generateId(prefix: string = '', length: number = 6): string {
    // 生成指定长度的随机字母数字字符串
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let randomStr = '';

    for (let i = 0; i < length; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        randomStr += chars[randomIndex];
    }

    // 时间戳确保唯一性，随机字符串降低碰撞概率
    const timestamp = Date.now().toString(36); // 使用36进制缩短时间戳长度

    if (prefix === '') {
        return `${timestamp}_${randomStr}`;
    }
    return `${prefix}_${timestamp}_${randomStr}`;
}

/**
 * 深拷贝函数
 * 支持各种数据类型的深拷贝，包括循环引用、Date、RegExp、ArrayBuffer、Map、Set等
 *
 * @template T
 * @param {T} value 要拷贝的值
 * @param {WeakMap<object, any>} [map = new WeakMap()] 用于处理循环引用的 WeakMap
 * @returns {T} 深拷贝后的值
 */
export const clone = <T>(value: T, map = new WeakMap<object, any>()): T => {
    // 处理基本类型和 null / undefined
    if (value === null || typeof value !== 'object') {
        return value;
    }

    // 处理循环引用
    if (map.has(value)) {
        return map.get(value);
    }

    // 处理 Date
    if (value instanceof Date) {
        const copy = new Date(value.getTime()) as unknown as T;
        map.set(value, copy);
        return copy;
    }

    // 处理 RegExp
    if (value instanceof RegExp) {
        const copy = new RegExp(value.source, value.flags) as unknown as T;
        map.set(value, copy);
        return copy;
    }

    // 处理 ArrayBuffer
    if (value instanceof ArrayBuffer) {
        const copy = value.slice(0) as unknown as T;
        map.set(value, copy);
        return copy;
    }

    // 处理 TypedArray (比如 Uint8Array 等)
    if (ArrayBuffer.isView(value)) {
        const typedArray = value as any;
        const copy = new (typedArray.constructor as any)(
            typedArray.buffer.slice(0),
            typedArray.byteOffset,
            typedArray.length
        ) as unknown as T;
        map.set(value, copy);
        return copy;
    }

    // 处理 Map
    if (value instanceof Map) {
        const copy = new Map() as unknown as T;
        map.set(value, copy);
        (value as Map<any, any>).forEach((val, key) => {
            (copy as Map<any, any>).set(clone(key, map), clone(val, map));
        });
        return copy;
    }

    // 处理 Set
    if (value instanceof Set) {
        const copy = new Set() as unknown as T;
        map.set(value, copy);
        (value as Set<any>).forEach((val) => {
            (copy as Set<any>).add(clone(val, map));
        });
        return copy;
    }

    // 处理 Array
    if (Array.isArray(value)) {
        const copy: any[] = [];
        map.set(value, copy);
        (value as any[]).forEach((item, index) => {
            copy[index] = clone(item, map);
        });
        return copy as unknown as T;
    }

    // 处理普通 Object
    const copy = Object.create(Object.getPrototypeOf(value)) as T;
    map.set(value, copy);
    for (const key in value) {
        if (Object.prototype.hasOwnProperty.call(value, key)) {
            (copy as any)[key] = clone((value as any)[key], map);
        }
    }

    // 处理 Symbol 属性
    const symbolKeys = Object.getOwnPropertySymbols(value);
    for (const symKey of symbolKeys) {
        (copy as any)[symKey] = clone((value as any)[symKey], map);
    }

    return copy;
}

/**
 * 模拟 Node.js 的 path.join() 函数
 * - 支持可变参数：join('a', 'b', 'c')
 * - 拼接并规范化路径
 * - 支持 ./ 和 ../
 * - 自动处理多余斜杠
 * - 过滤空字符串路径片段
 * - 不将 '/xxx' 或 'C:\' 当作绝对路径重置（与 path.join 行为一致）
 * - 返回使用 '/' 分隔的路径（跨平台通用）
 *
 * @param paths 可变数量的路径片段
 * @returns {string} 拼接并规范化后的路径字符串
 *
 * @example
 * join('a', 'b', 'c')           // 'a/b/c'
 * join('a', '../b', './c')      // 'b/c'
 * join('a', '', 'b//c')         // 'a/b/c'
 * join('a', '/not/ignored')     // 'a/not/ignored'
 * join()                        // ''
 * join('a')                     // 'a'
 */
export function join(...paths: string[]): string {
    // 1. 过滤掉空字符串或全是空格的路径片段
    const filtered = paths
        .map(p => p.trim().replace(/\\+/g, '/'))
        .filter(p => p.trim() !== '');

    if (filtered.length === 0) return '';

    // 2. 拼接所有路径片段，用 '/' 连接
    let joined = filtered.join('/');

    // 3. 拆分成片段，过滤掉空（由 // 或开头/结尾导致）
    const parts = joined.split('/').filter(Boolean);

    const stack: string[] = [];

    for (const part of parts) {
        if (part === '.') {
            // 当前目录，无操作

        } else if (part === '..') {
            // 上一级目录：弹出栈顶元素（模拟返回上级）
            if (stack.length > 0) {
                stack.pop();
            }
        } else {
            // 普通路径部分，入栈
            stack.push(part);
        }
    }

    // 4. 重新组合为规范化路径
    return formatPath(stack.join('/'));
}

/**
 * 归一化文件路径：反斜杠 → 正斜杠 + 全部小写。
 *
 * @param path 原始路径（可为空）
 * @returns {string} 归一化后的路径；空值返回空串
 *
 * @example
 * normalizePath('C:\\Foo\\Bar.MP3')   // 'c:/foo/bar.mp3'
 * normalizePath(undefined)            // ''
 */
export function normalizePath(path?: string): string {
    return path ? path.replace(/\\/g, '/').toLowerCase() : '';
}

/**
 * 判定可否安全交给系统默认浏览器打开：仅放行 http/https 绝对地址。
 * 拦截 javascript:/data:/file: 等可被 shell.openExternal 利用的协议。
 */
export function isSafeExternalUrl(url: unknown): url is string {
    if (typeof url !== 'string') return false
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
    } catch {
        return false
    }
}

/**
 * 比较两段三段式版本号。返回 >0 表示 a 更新，<0 表示 a 更旧，0 表示相同。
 *
 * @example
 * compareVersion('0.1.5', '0.1.4')  // > 0
 * compareVersion('0.1.4', '0.1.5')  // < 0
 * compareVersion('0.1.4', '0.1.4')  // 0
 */
export function compareVersion(a: string, b: string): number {
    const pa = a.split('.')
    const pb = b.split('.')
    for (let i = 0; i < 3; i++) {
        const d = (Number(pa[i]) || 0) - (Number(pb[i]) || 0)
        if (d !== 0) return d
    }
    return 0
}