import { db } from '@main/db'

export interface StorageManager {
    /** 获取存储值 */
    get(pluginId: string, key: string): unknown

    /** 设置存储值 */
    set(pluginId: string, key: string, value: unknown): void

    /** 删除存储键 */
    delete(pluginId: string, key: string): void

    /** 获取插件所有存储键名 */
    keys(pluginId: string): string[]

    /** 清除指定插件的全部存储（插件卸载时使用） */
    clearAll(pluginId: string): void
}

export function createStorageManager(): StorageManager {
    function get(pluginId: string, key: string): unknown {
        const rows = db.query(
            'SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?',
            [pluginId, key]
        )
        if (rows.length === 0) return undefined
        const raw = rows[0].value
        // db.query 会对 { / [ 开头的列自动 JSON 解析（对象/数组）；其余原样返回（字符串/数字/布尔的 JSON 文本）
        if (typeof raw === 'string') {
            try {
                return JSON.parse(raw)
            } catch {
                return raw
            }
        }
        return raw
    }

    function set(pluginId: string, key: string, value: unknown): void {
        const serialized = JSON.stringify(value)
        const existing = db.find('plugin_storage', { pluginId, key })
        if (existing) {
            db.update('plugin_storage', { pluginId, key }, { value: serialized })
        } else {
            db.create('plugin_storage', { pluginId, key, value: serialized })
        }
    }

    function del(pluginId: string, key: string): void {
        db.delete('plugin_storage', { pluginId, key })
    }

    function keys(pluginId: string): string[] {
        const rows = db.query('SELECT key FROM plugin_storage WHERE plugin_id = ?', [pluginId])
        return rows.map((r) => String(r.key))
    }

    function clearAll(pluginId: string): void {
        db.delete('plugin_storage', { pluginId })
    }

    return { get, set, delete: del, keys, clearAll }
}
