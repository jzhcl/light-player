import { invoke, invokeResult } from './ipc'
import type { FileEncoding, FileInfo, FileSelectionOptions } from '@shared/types/file'


/** 读文件。`encoding` 传 `'base64'` 时返回 base64 字符串 */
export async function readFile(path: string, encoding?: FileEncoding): Promise<Result<string>> {
    return invokeResult<string>('file:read', path, encoding)
}

export async function writeFile(
    path: string,
    content: string | Uint8Array,
    encoding?: FileEncoding,
): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:write', path, content, encoding)
}

/** 创建文件（已存在则跳过），content 默认空字符串，encoding 默认 utf-8 */
export async function createFile(
    path: string,
    content?: string | Uint8Array,
    encoding?: FileEncoding,
): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:create', path, content, encoding)
}

export async function deleteFile(path: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:delete', path)
}

/** 递归删除目录（含内容） */
export async function deleteDirectory(dir: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:deleteDirectory', dir)
}

export async function copyFile(src: string, dest: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:copy', src, dest)
}

export async function moveFile(src: string, dest: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:move', src, dest)
}

export async function ensureDir(dir: string): Promise<Result<boolean>> {
    return invokeResult<boolean>('file:ensureDir', dir)
}

/** 列出目录下的一层文件/目录信息（目录无效时返回失败） */
export async function listDir(dir: string): Promise<Result<FileInfo[]>> {
    return invokeResult<FileInfo[]>('file:listDir', dir)
}

export async function isFileExists(path: string): Promise<boolean> {
    return invoke<boolean>('file:exists', path)
}

/** 批量存在性探测，返回数组与入参一一对应 */
export async function existsMany(paths: string[]): Promise<boolean[]> {
    return invoke<boolean[]>('file:existsMany', paths)
}

/** 查询单个文件/目录信息，路径无效返回 null */
export async function getFileInfo(path: string): Promise<FileInfo | null> {
    return invoke<FileInfo | null>('file:getInfo', path)
}

/** 弹窗选择单个文件，取消返回 null */
export async function selectFile(options?: FileSelectionOptions): Promise<string | null> {
    return invoke<string | null>('file:selectFile', options)
}

/** 弹窗选择多个文件，取消返回 [] */
export async function selectFiles(options?: FileSelectionOptions): Promise<string[]> {
    return invoke<string[]>('file:selectFiles', options)
}

/** 弹窗选择目录，取消返回 null */
export async function selectDirectory(options?: FileSelectionOptions): Promise<string | null> {
    return invoke<string | null>('file:selectDirectory', options)
}

/** 在资源管理器中定位显示文件/目录 */
export async function showItemInFolder(itemPath: string): Promise<void> {
    return invoke<void>('file:showItemInFolder', itemPath)
}

/** 在资源管理器中打开目录，返回 '' 表示成功，非空为错误信息 */
export async function openDirInExplorer(dir: string): Promise<string> {
    return invoke<string>('file:openDirInExplorer', dir)
}
