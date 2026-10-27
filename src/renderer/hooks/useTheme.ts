import { useEffect } from 'react'
import { useSettingsStore } from '@renderer/store'
import { toFileUrl } from '@renderer/lib/utils'
import { rlog } from '@renderer/lib/log'
import lightCssUrl from '@renderer/styles/themes/light.css?url'
import darkCssUrl from '@renderer/styles/themes/dark.css?url'
// 内置主题配色
import lightCssRaw from '@renderer/styles/themes/light.css?raw'
import darkCssRaw from '@renderer/styles/themes/dark.css?raw'

/**
 * 主题配色中砖预览真正会消费的那两个色（对应主题 CSS 的 --color-*）。
 *
 * 只有两个字段：一块砖只表达「该主题的画布底色」与「该主题的主色」——
 *    左侧预览槽铺 `fill`（有预览图时铺图），右下方块铺 `primary`。
 */
export interface ThemeColors {
    primary: string
    fill: string
}

/** 预览所需变量名 → ThemeColors 字段 */
const COLOR_VAR_MAP: Record<keyof ThemeColors, string> = {
    primary: '--color-primary',
    fill: '--color-fill',
}

/** 兜底：主题变量全缺时使用（正常路径不会走到） */
const COLOR_FALLBACK: ThemeColors = {
    primary: 'rgb(230, 0, 83)',
    fill: 'rgb(245, 246, 248)',
}

/**
 * 从主题 CSS 文本中提取配色变量。
 * - 先剥注释：新建主题的模板把变量示例写在注释里，不剥会把注释误判成已定义
 * - 只扫 :root 块；同文件内多次声明时后者覆盖前者（与层叠顺序一致）
 */
export function parseThemeColorVars(css: string): Partial<ThemeColors> {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const roots = stripped.match(/:root\s*\{[^}]*}/g)
    if (!roots) return {}
    const decls = roots.join('\n')
    const out: Partial<ThemeColors> = {}
    for (const key of Object.keys(COLOR_VAR_MAP) as (keyof ThemeColors)[]) {
        const m = new RegExp(`${COLOR_VAR_MAP[key]}\\s*:\\s*([^;]+);`).exec(decls)
        if (m) out[key] = m[1].trim()
    }
    return out
}

/** 内置浅色 / 深色主题的配色 */
export const BUILTIN_THEME_COLORS: Record<'light' | 'dark', ThemeColors> = {
    light: { ...COLOR_FALLBACK, ...parseThemeColorVars(lightCssRaw) },
    dark: { ...COLOR_FALLBACK, ...parseThemeColorVars(darkCssRaw) },
}

/**
 * 某主题最终用于预览的配色 = 当前内置方案打底 + 主题自身覆盖。
 * 底座是必需的：inheritBuiltin 主题通常只声明少数变量（其余继承内置），
 * 没有底座时这些变量为空，预览就会缺色。
 */
export function resolveThemeColors(vars?: Partial<ThemeColors>): ThemeColors {
    return { ...BUILTIN_THEME_COLORS[resolveBuiltinVariant()], ...vars }
}

const BUILTIN_LINK_ID = 'lp-builtin-theme'
const CUSTOM_LINK_ID = 'lp-custom-theme'

type BuiltinScheme = 'light' | 'dark' | 'system'

interface ThemeLike {
    name: string
    styleFile: string
    inheritBuiltin?: boolean
}

// 内置主题 CSS 的运行时 URL
const BUILTIN_CSS: Record<'light' | 'dark', string> = {
    light: lightCssUrl,
    dark: darkCssUrl,
}

/** 设置/移除内置主题 <link>（id 固定，切换浅/深即改 href 或移除）。 */
function setBuiltinLink(href: string | null): void {
    let el = document.getElementById(BUILTIN_LINK_ID) as HTMLLinkElement | null
    if (!href) {
        el?.remove()
        return
    }
    if (!el) {
        el = document.createElement('link')
        el.id = BUILTIN_LINK_ID
        el.rel = 'stylesheet'
        document.head.appendChild(el)
    }
    el.href = href
}

/** 设置/移除自定义主题 <link>。传 null 时移除（切回内置主题） */
function setCustomLink(href: string | null): void {
    let el = document.getElementById(CUSTOM_LINK_ID) as HTMLLinkElement | null
    if (!href) {
        el?.remove()
        return
    }
    if (!el) {
        el = document.createElement('link')
        el.id = CUSTOM_LINK_ID
        el.rel = 'stylesheet'
        document.head.appendChild(el)
    }
    el.onerror = () => rlog.error(`[theme] 自定义主题样式表加载失败：${href}`)
    el.href = href
}

/** 内置在前、自定义在后 */
function ensureBuiltinBeforeCustom(): void {
    const builtin = document.getElementById(BUILTIN_LINK_ID)
    const custom = document.getElementById(CUSTOM_LINK_ID)
    if (!builtin || !custom) return
    // `a.compareDocumentPosition(b)` 描述的是 b 相对 a 的位置：返回 PRECEDING 说明
    // custom 排在 builtin 之前（顺序错了）→ 把 builtin 插到 custom 前面掰正。
    if (builtin.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_PRECEDING) {
        custom.parentNode?.insertBefore(builtin, custom)
    }
}

/** 系统是否偏好深色 */
function getSystemPrefersDark(): boolean {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/**
 * 解析实际要应用的内置变体：
 * - 'system'：跟随系统配色（深→dark，否则 light）
 * - 'light' / 'dark'：直接采用
 */
function resolveBuiltinVariant(): 'light' | 'dark' {
    const scheme = useSettingsStore.getState().settings['theme.builtinScheme'] as BuiltinScheme
    if (scheme === 'system') return getSystemPrefersDark() ? 'dark' : 'light'
    return scheme
}

/**
 * 上次实际应用到 DOM 的组合：内置变体 + styleFile + inheritBuiltin。
 * 组合相同直接返回：DOM 已处于该组合下，无需再动。
 */
let lastAppliedKey: string | null = null

function themeApplyKey(variant: 'light' | 'dark', theme: ThemeLike): string {
    return `${variant}\u0000${theme.styleFile}\u0000${theme.inheritBuiltin ? 1 : 0}`
}

/**
 * 应用主题（同步，幂等）。
 *
 * - 内置主题（无 styleFile）：仅引入对应变体内置 <link>（light/dark），移除自定义 <link>。
 * - 自定义 + inheritBuiltin：先引入内置变体作底座 <link>，再在其后追加自定义 <link> 覆盖。
 * - 自定义 + 非 inheritBuiltin：不引入内置，仅自定义 <link>（自定义需自带全部 --color-*）。
 */
export function applyTheme(theme: ThemeLike): void {
    const variant = resolveBuiltinVariant()
    const key = themeApplyKey(variant, theme)
    if (key === lastAppliedKey) return
    lastAppliedKey = key

    if (!theme.styleFile) {
        // 内置主题：只留内置 <link>
        setBuiltinLink(BUILTIN_CSS[variant])
        setCustomLink(null)
    } else if (theme.inheritBuiltin) {
        // 继承型自定义：内置作底座 + 自定义覆盖
        setBuiltinLink(BUILTIN_CSS[variant])
        setCustomLink(toFileUrl(theme.styleFile))
    } else {
        // 自足型：不加载内置，自定义需自带全部 --color-*
        setBuiltinLink(null)
        setCustomLink(toFileUrl(theme.styleFile))
    }

    ensureBuiltinBeforeCustom()

    rlog.info(
        theme.styleFile
            ? `[theme] 应用主题：自定义「${theme.name}」${theme.inheritBuiltin ? ` + 内置底座 ${variant}` : ''} ← ${theme.styleFile}`
            : `[theme] 应用主题：内置 ${variant}`,
    )
}

/**
 * 首屏前同步应用当前主题，避免无主题 CSS 的闪白。
 */
export function initTheme(): void {
    const theme = useSettingsStore.getState().settings['theme.current']
    applyTheme(theme)
}

/**
 * 重新加载「当前主题」
 */
export function reloadCustomTheme(): void {
    const theme = useSettingsStore.getState().settings['theme.current']
    if (!theme.styleFile) return
    // 加时间戳强制重新请求，绕过 <link> 的缓存
    const url = toFileUrl(theme.styleFile) + '?v=' + Date.now()
    setCustomLink(null)
    setCustomLink(url)
    ensureBuiltinBeforeCustom()
    rlog.info(`[theme] 重新加载当前主题：${theme.name} ← ${theme.styleFile}`)
}

export function useTheme(): void {
    const theme = useSettingsStore((s) => s.settings['theme.current'])
    const scheme = useSettingsStore((s) => s.settings['theme.builtinScheme'])

    useEffect(() => {
        applyTheme(theme)
    }, [theme.name, theme.styleFile, theme.inheritBuiltin, scheme])

    // 跟随系统：监听系统配色变化，仅在内置主题 + 方案=system 时重应用。
    useEffect(() => {
        const mq = window.matchMedia('(prefers-color-scheme: dark)')
        const onChange = () => {
            const s = useSettingsStore.getState().settings
            if (s['theme.builtinScheme'] === 'system' && !s['theme.current'].styleFile) {
                applyTheme(s['theme.current'])
            }
        }
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
    }, [])
}
