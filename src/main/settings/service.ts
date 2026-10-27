import { db } from '../db'
import { getDefaultMainSettings, type MainSettingKey } from './defaults'


const stringify = <T>(val: T): { __val: T } => {
    return {
        __val: val
    }
}


const parse = <T>(val: { __val: T }): T => {
    return val?.__val
}

/**
 * 读取单个设置。DB 无记录或失败则回落默认
 */
export function getSetting<K extends MainSettingKey>(key: K): LP.MainSetting[K] {
    const row = db.find('main_settings', { id: key })
    if (row && row.value !== null && row.value !== undefined) {
        return parse(row.value as any) as LP.MainSetting[K]
    }
    return getDefaultMainSettings()[key]
}

/** 写入单个设置 */
export function setSetting<K extends MainSettingKey>(key: K, value: LP.MainSetting[K]): void {
    db.upsert('main_settings', { id: key }, { value: stringify(value) })
}


/**
 * 应用启动时种子化默认设置：仅插入缺失键，不覆盖已有记录
 */
export function initSettings(): void {
    const d = getDefaultMainSettings()
    for (const key of Object.keys(d) as unknown as MainSettingKey[]) {
        const existing = db.find('main_settings', { id: key })
        if (!existing) {
            db.create('main_settings', { id: key, value: stringify(d[key]) })
        }
    }
}
