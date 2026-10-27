declare namespace LP {
    /**
     * plugins 表 + plugin_storage 表
     */

    /** plugins 表：插件注册信息 */
    interface Plugin {
        /** 插件 ID */
        id: string
        /** 插件名称 */
        name: string
        /** 插件版本 */
        version: string
        /** 是否启用 */
        enabled: boolean
        /** 插件目录路径 */
        dirPath: string
        /** plugin.json 完整内容（JSON） */
        manifest: Record<string, unknown>
        /** 命令与 Provider 的启停配置（JSON） */
        config: Record<string, unknown>
        /** 生命周期状态 */
        state: 'installed' | 'active' | 'error' | string
        /** 激活/运行错误信息 */
        error?: string
        /** 安装时间 */
        installedAt?: string
        /** 更新时间 */
        updatedAt?: string
    }

    /** plugin_storage 表：lp.storage API 的持久化（值 JSON 序列化） */
    interface PluginStorage {
        /** 插件 ID */
        pluginId: string
        /** 键名 */
        key: string
        /** 值（JSON 序列化） */
        value: string
    }
}
