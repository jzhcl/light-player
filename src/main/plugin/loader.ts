// 插件加载器：扫描插件目录、读取并校验 plugin.json、提供源码读取

import { join } from 'node:path'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { PATHS } from '@main/constants/paths'
import { log } from '@main/log'
import { formatError } from '@shared/result'


export function validatePluginId(id: string): string | null {
    if (!id) return '插件 ID 不能为空'
    if (id.length > 24) return `插件 ID 超过 24 字符限制: ${id}`
    const PLUGIN_ID_REGEX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/
    if (!PLUGIN_ID_REGEX.test(id)) return `插件 ID 格式非法: ${id}`
    return null
}

/**
 * 校验 plugin.json 的完整性和一致性。
 * 返回 null 表示通过，否则返回错误描述。
 */
export function validateManifest(manifest: unknown): string | null {
    if (!manifest || typeof manifest !== 'object') {
        return 'plugin.json 不是有效的 JSON 对象'
    }
    const m = manifest as Record<string, unknown>

    const required = ['id', 'name', 'version', 'main', 'activationEvents'] as const
    for (const field of required) {
        if (!m[field]) return `plugin.json 缺少必填字段: ${field}`
    }

    const idError = validatePluginId(String(m.id))
    if (idError) return idError

    if (!Array.isArray(m.activationEvents) || (m.activationEvents as unknown[]).length === 0) {
        return 'activationEvents 必须是非空数组'
    }

    const contributions = m.contributions as Record<string, unknown> | undefined

    // 菜单项引用的 command 必须在 commands 中声明过
    if (contributions?.menus && Array.isArray(contributions.menus)) {
        const declared = new Set(
            ((contributions.commands as Record<string, unknown>[]) || []).map((c) => String(c.command))
        )
        for (const menu of contributions.menus as Record<string, unknown>[]) {
            const cmd = String(menu.command)
            if (!declared.has(cmd)) return `菜单引用了未声明的命令: ${cmd}`
        }
    }

    // Provider 声明校验
    if (contributions?.providers && Array.isArray(contributions.providers)) {
        for (const p of contributions.providers as Record<string, unknown>[]) {
            if (!p.targetPlugin || typeof p.targetPlugin !== 'string') {
                return 'provider 声明缺少有效的 targetPlugin'
            }
            if (!p.command || typeof p.command !== 'string') {
                return 'provider 声明缺少有效的 command'
            }
        }
    }

    // 视图声明校验
    if (contributions?.views && Array.isArray(contributions.views)) {
        const VALID_CONTAINERS = ['modal', 'settings']
        const seenIds = new Set<string>()
        const settingsViews: string[] = []
        for (const v of contributions.views as Record<string, unknown>[]) {
            if (!v.id || typeof v.id !== 'string') {
                return 'view 声明缺少有效的 id'
            }
            if (seenIds.has(v.id as string)) {
                return `view id 重复: ${String(v.id)}`
            }
            seenIds.add(v.id as string)
            if (!v.entry || typeof v.entry !== 'string') {
                return `view "${String(v.id)}" 缺少有效的 entry`
            }
            if (!v.container || !VALID_CONTAINERS.includes(v.container as string)) {
                return `view "${String(v.id)}" 的 container 必须是 modal / settings`
            }
            if (v.container === 'settings') settingsViews.push(String(v.id))
        }
        // 设置页是「一插件一页」：多声明属架构错误
        if (settingsViews.length > 1) {
            return `container=settings 的视图最多 1 个（当前 ${settingsViews.length} 个：${settingsViews.join('、')}）`
        }
    }

    return null
}

export interface PluginLoader {
    /** 扫描插件目录，返回所有合法插件的 manifest 列表 */
    discover(): PluginManifest[]

    /** 读取插件主入口文件的源码内容 */
    getSource(pluginId: string): string | null

    getManifest(pluginId: string): PluginManifest | undefined

    getDirPath(pluginId: string): string | undefined

    getAllManifests(): PluginManifest[]
}

export function createPluginLoader(): PluginLoader {
    const manifests = new Map<string, PluginManifest>()
    const dirs = new Map<string, string>()

    /** 扫描插件目录 */
    function discover(): PluginManifest[] {
        manifests.clear()
        dirs.clear()

        const pluginsDir = PATHS.getPlugins()
        if (!existsSync(pluginsDir)) return []

        let entries: string[]
        try {
            entries = readdirSync(pluginsDir)
        } catch (e) {
            // 整个插件目录读不了
            log.error(`[plugin] 读取插件目录失败 ${pluginsDir}\n${formatError(e)}`)
            return []
        }

        for (const entry of entries) {
            const dirPath = join(pluginsDir, entry)
            try {
                if (!statSync(dirPath).isDirectory()) continue
            } catch (e) {
                log.warn(`[plugin] 跳过 ${entry}：无法访问（${formatError(e)}）`)
                continue
            }

            const manifestPath = join(dirPath, 'plugin.json')
            if (!existsSync(manifestPath)) continue

            let raw: string
            try {
                raw = readFileSync(manifestPath, 'utf-8')
            } catch (e) {
                log.warn(`[plugin] 跳过 ${entry}：plugin.json 读取失败（${formatError(e)}）`)
                continue
            }

            let parsed: PluginManifest
            try {
                parsed = JSON.parse(raw) as PluginManifest
            } catch (e) {
                log.warn(`[plugin] 跳过 ${entry}：plugin.json 不是合法 JSON（${formatError(e)}）`)
                continue
            }

            const error = validateManifest(parsed)
            if (error) {
                log.warn(`[plugin] 跳过 ${entry}：清单校验未通过（${error}）`)
                continue
            }

            manifests.set(parsed.id, parsed)
            dirs.set(parsed.id, dirPath)
        }

        return Array.from(manifests.values())
    }

    function getSource(pluginId: string): string | null {
        const manifest = manifests.get(pluginId)
        const dirPath = dirs.get(pluginId)
        if (!manifest || !dirPath) return null
        const mainPath = join(dirPath, manifest.main)
        try {
            return readFileSync(mainPath, 'utf-8')
        } catch (e) {
            // 清单在、入口源码读不到
            log.error(`[plugin] 读取 ${pluginId} 源码失败 ${mainPath}\n${formatError(e)}`)
            return null
        }
    }

    function getManifest(pluginId: string): PluginManifest | undefined {
        return manifests.get(pluginId)
    }

    function getDirPath(pluginId: string): string | undefined {
        return dirs.get(pluginId)
    }

    function getAllManifests(): PluginManifest[] {
        return Array.from(manifests.values())
    }

    return { discover, getSource, getManifest, getDirPath, getAllManifests }
}
