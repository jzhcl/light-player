import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync
} from 'node:fs'
import { access } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import type { FileEncoding, FileInfo } from '@shared/types/file'
import { log } from '@main/log'

/** 内容的字节数 */
const sizeOf = (content: string | Uint8Array): number =>
    typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength

/**
 * 应用自身数据目录的归一化前缀（惰性求值：模块加载时 app 可能尚未 ready）
 */
let userDataPrefix: string | null = null

const normalize = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

/**
 * 路径是否落在应用的 userData 里（缓存 / DB / 日志 / 插件都在这里）。
 */
function isInternalPath(path: string): boolean {
    userDataPrefix ??= normalize(app.getPath('userData'))
    const n = normalize(path)
    return n === userDataPrefix || n.startsWith(`${userDataPrefix}/`)
}

/**
 * 文件操作审计日志。
 *
 * 意义是给「写到用户地盘」留痕
 */
function audit(path: string, text: string): void {
    if (!isInternalPath(path)) log.info(text)
}

/** 磁盘上现有文件的字节数：不存在或读不到按 0 算 */
const sizeOnDisk = (path: string): number => {
    try {
        return statSync(path).size
    } catch {
        return 0
    }
}

/** 是否存在 */
export function isFileExist(path: string): boolean {
    return existsSync(path)
}

/** 是否存在（异步） */
export async function isFileExistAsync(path: string): Promise<boolean> {
    try {
        await access(path)
        return true
    } catch {
        return false
    }
}

/** 递归创建目录 */
export function ensureDir(dir: string): void {
    if (existsSync(dir)) return
    try {
        mkdirSync(dir, { recursive: true })
    } catch (err) {
        throw new Error(`创建目录失败: ${dir} (${(err as Error).message})`)
    }
    audit(dir, `[file] 创建目录 ${dir}`)
}

/** 读取文本文件 */
export function readFile(path: string, encoding: BufferEncoding = 'utf-8'): string {
    if (!existsSync(path)) throw new Error(`文件不存在: ${path}`)
    try {
        return readFileSync(path, encoding)
    } catch (err) {
        throw new Error(`读取文件失败: ${path} (${(err as Error).message})`)
    }
}

/** 写入文件，自动创建父目录 */
export function writeFile(path: string, content: string | Uint8Array, encoding: FileEncoding = 'utf-8'): void {
    const before = sizeOnDisk(path)
    try {
        mkdirSync(dirname(path), { recursive: true })
        if (typeof content === 'string') {
            writeFileSync(path, content, encoding)
        } else {
            writeFileSync(path, content)
        }
    } catch (err) {
        throw new Error(`写入文件失败: ${path} (${(err as Error).message})`)
    }
    const overwritten = before > 0 ? `, 覆盖 ${before} B` : ''
    audit(path, `[file] 写入文件 ${path} (${sizeOf(content)} B${overwritten})`)
}

/** 创建文件：已存在则不做操作；不存在则创建。content 默认空字符串，encoding 默认 utf-8。 */
export function createFile(path: string, content: string | Uint8Array = '', encoding: FileEncoding = 'utf-8'): void {
    if (existsSync(path)) return
    try {
        mkdirSync(dirname(path), { recursive: true })
        if (typeof content === 'string') {
            writeFileSync(path, content, encoding)
        } else {
            writeFileSync(path, content)
        }
    } catch (err) {
        throw new Error(`创建文件失败: ${path} (${(err as Error).message})`)
    }
    audit(path, `[file] 创建文件 ${path} (${sizeOf(content)} B)`)
}

/** 删除文件。不存在视为已删除；权限/占用等错误 throw。 */
export function deleteFile(path: string): void {
    if (!existsSync(path)) return
    try {
        unlinkSync(path)
    } catch (err) {
        throw new Error(`删除文件失败: ${path} (${(err as Error).message})`)
    }
    audit(path, `[file] 删除文件 ${path}`)
}

/** 递归删除目录（含内容）。不存在视为成功；权限/占用等错误 throw。 */
export function deleteDirectory(dir: string): void {
    if (!existsSync(dir)) return
    try {
        rmSync(dir, { recursive: true, force: true })
    } catch (err) {
        throw new Error(`删除目录失败: ${dir} (${(err as Error).message})`)
    }
    audit(dir, `[file] 删除目录 ${dir}`)
}

/** 复制文件到 dest，自动创建父目录。 */
export function copyFile(src: string, dest: string): void {
    try {
        mkdirSync(dirname(dest), { recursive: true })
        copyFileSync(src, dest)
    } catch (err) {
        throw new Error(`复制文件失败: ${src} -> ${dest} (${(err as Error).message})`)
    }
}

/** 移动/重命名文件到 dest，自动创建父目录。跨设备时回退为 copy + 删源。 */
export function moveFile(src: string, dest: string): void {
    try {
        mkdirSync(dirname(dest), { recursive: true })
        try {
            renameSync(src, dest)
        } catch (renameErr) {
            if ((renameErr as NodeJS.ErrnoException).code === 'EXDEV') {
                copyFileSync(src, dest)
                unlinkSync(src)
            } else {
                throw renameErr
            }
        }
    } catch (err) {
        throw new Error(`移动文件失败: ${src} -> ${dest} (${(err as Error).message})`)
    }
    audit(dest, `[file] 移动 ${src} -> ${dest}`)
}

/** 获取单个文件/目录信息。路径不存在或不可访问时返回 null。 */
export function getFileInfo(path: string): FileInfo | null {
    try {
        const stats = statSync(path)
        return {
            path,
            name: basename(path),
            size: stats.size,
            lastModified: stats.mtimeMs,
            type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other',
        }
    } catch {
        return null
    }
}

/** 列出目录下的一层文件/目录信息（不递归）。目录无效时 throw。 */
export function getDirectoryFiles(dir: string): FileInfo[] {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new Error(`目录不存在或不是目录: ${dir}`)
    }
    try {
        return readdirSync(dir)
            .map((name) => getFileInfo(join(dir, name)))
            .filter((info): info is FileInfo => info !== null)
    } catch (err) {
        throw new Error(`读取目录失败: ${dir} (${(err as Error).message})`)
    }
}
