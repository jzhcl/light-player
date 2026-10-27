import { useEffect, useState } from 'react'

/**
 * 跟踪渲染窗口宽度
 */
export function useWindowWidth(): number {
    const [width, setWidth] = useState(() => window.innerWidth)

    useEffect(() => {
        const onResize = () => setWidth(window.innerWidth)
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    return width
}
