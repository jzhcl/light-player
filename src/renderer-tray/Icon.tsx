import type { CSSProperties } from 'react'
import { icons, type IconName } from '@assets/icons'

interface TrayIconProps {
    name: IconName
    size?: number
}

/** 复用主渲染端的图标资源与上色方式，托盘样式里只需给出 .icon 的几何 */
export function TrayIcon({ name, size = 16 }: TrayIconProps) {
    const Svg = icons[name]
    const style = { '--icon-size': `${size}px` } as CSSProperties
    return (
        <span className="icon" style={style} aria-hidden="true">
            <Svg />
        </span>
    )
}
