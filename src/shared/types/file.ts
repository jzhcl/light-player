/** 文件信息 */
export interface FileInfo {
    path: string
    name: string
    /** 字节数 */
    size: number
    /** 修改时间（epoch ms） */
    lastModified: number
    type: 'file' | 'directory' | 'other'
}

/** 文件编码 */
export type FileEncoding = 'utf-8' | 'ascii' | 'latin1' | 'base64' | 'hex' | 'utf16le'

/** 文件选择对话框选项 */
export interface FileSelectionOptions {
    title?: string
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
}
