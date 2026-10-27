export interface PluginIconProps {
    /** 运行时注入的绝对 file:// URL（PluginInfo.iconUrl）；缺省 = 该插件没有图标 */
    iconUrl?: string
    className?: string
}

/**
 * 插件图标：manifest 的 `icon` 由主进程解析成 iconUrl 后在这里显示。
 *
 * 图标文件缺失/损坏 → img onError 就地隐藏，避免浏览器碎图占位。
 */
export function PluginIcon({ iconUrl, className }: PluginIconProps) {
    if (!iconUrl) return null
    return (
        <img
            className={className ? `plugin-icon ${className}` : 'plugin-icon'}
            src={iconUrl}
            alt=""
            onError={(e) => {
                e.currentTarget.hidden = true
            }}
        />
    )
}
