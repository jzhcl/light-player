import type { CSSProperties } from 'react'
import { icons, type IconName } from '@assets/icons'

interface IconProps {
    /** 内置图标名（编译期打包，见 @assets/icons 注册表） */
    name?: IconName
    /** 运行时图标地址（插件图标等编译期不可知的场景），优先于 name */
    src?: string
    /** 尺寸（px），默认 16 */
    size?: number
    /** 附加类名（挂到根 span，便于定位/尺寸覆盖） */
    className?: string
}

/**
 * 图标：内置图标走 svgr 组件，运行时图标走 CSS mask（把 SVG 当遮罩）。
 * 两种都用 currentColor 上色，颜色完全由父级 color 决定
 */
export function Icon({ name, src, size = 16, className }: IconProps) {
    const sizeStyle = { '--icon-size': `${size}px` } as CSSProperties
    const cls = className ? ` icon ${className}` : ''

    // 运行时图标：mask-image 必须内联（地址动态），上色方式由主题的 .icon--mask 给出
    if (src) {
        return (
            <span
                className={`icon icon--mask${cls}`}
                style={{
                    ...sizeStyle,
                    maskImage: `url(${src})`,
                    WebkitMaskImage: `url(${src})`,
                }}
            />
        )
    }

    const Svg = name ? icons[name] : undefined
    if (!Svg) return null

    return (
        <span className={`icon${cls}`} style={sizeStyle}>
            <Svg />
        </span>
    )
}
