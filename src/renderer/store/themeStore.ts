import { create } from 'zustand'
import { invoke } from '@renderer/lib/ipc'
import { fail, isOk, ok } from '@shared/result'
import {
    deleteDirectory,
    ensureDir,
    isFileExists,
    listDir,
    openDirInExplorer,
    readFile,
    writeFile,
} from '@renderer/lib/file'
import { toFileUrl } from '@renderer/lib/utils'
import { join } from '@shared/utils'
import { useSettingsStore } from '@renderer/store'
import fallbackCss from '@renderer/styles/themes/fallback.css?raw'
import {
    applyTheme,
    parseThemeColorVars,
    reloadCustomTheme,
    type ThemeColors,
} from '@renderer/hooks/useTheme'

export interface ThemeInfo {
    id: string
    name: string
    builtin: boolean
    dir: string
    styleFile: string
    inheritBuiltin: boolean
    author?: string
    description?: string
    version?: string
    /** 从主题 style.css 解析出的配色变量（供「外观」页预览） */
    colorVars?: Partial<ThemeColors>
    /**
     * 预览图（已解析成能直接赋 `src` 的 file:// URL，主题没给或全无效时为空数组）。
     * 来源是 `theme.json` 的 `preview: string[]`（相对主题目录的文件名）。
     */
    preview: string[]
}

// 内置主题：其 CSS 由 useTheme 以 <link> 动态引入（浅/深二选一，不两份并存，也不靠 data-theme 切换）。
// 具体浅/深由 theme.builtinScheme 决定，列表项名统一为「内置」，方案由右侧 Select 选择。
const BUILTIN_THEMES: ThemeInfo[] = [
    { id: 'builtin', name: '内置', builtin: true, dir: '', styleFile: '', inheritBuiltin: false, preview: [] },
]

const THEME_STYLE_IMPORT = `@import './fallback.css';

`

// 新建主题 style.css 基线：继承内置底座（inheritBuiltin=true）时，只覆盖想改的变量即可。
const THEME_STYLE_TEMPLATE = `/* 自定义主题样式
 *
 * - inheritBuiltin=true（默认）：内置浅色/深色主题作为底座 <link> 先加载（由外观页「方案」决定浅/深），
 *   本文件只需覆盖想改的变量，未覆盖的自动继承自内置主题。
 * - inheritBuiltin=false：不加载内置底座，本文件需自带全部 --color-* 变量（可复制内置主题源码作起点）。
 *
 * 变量统一声明在 :root（与内置主题同一层），链接顺序在内置之后，cascade 自然覆盖。
 * 几何/布局由程序统一控制，无需在此书写。
 */
:root {
    /* 示例：取消注释后覆盖主色与画布底色（其余变量继承内置）
    --color-primary: rgb(0, 122, 255);
    --color-primary-rgb: 0, 122, 255;
    --color-fill: rgb(250, 250, 252);
    */
}
`

const THEME_README = `# 主题自定义说明

1. 编辑本目录下的 style.css，回到「设置 → 外观」点击「重新加载当前主题」即可预览（无需重启）。
2. 点击「开发者工具」可审查 DOM 与类名，编写针对性 CSS。
3. theme.json 的 inheritBuiltin：
   - true（默认）：内置浅色/深色主题作为底座 <link> 先加载（由外观页「方案」决定浅/深），本目录 style.css 仅覆盖想改的变量，其余继承内置，适合只改颜色。
   - false：内置主题不兜底，本目录 style.css 需自带全部 --color-* 变量（参考内置浅色主题源码复制修改）。
4. 内置浅色主题源码见 src/renderer/styles/themes/light/ 目录（按区域拆分为 titlebar / navbar / control / components / song-list / content-page / settings / play / settings-page），可作为起点复制修改。
5. 在 :root 定义标准 --color-* 变量（如 --color-primary、--color-text-primary、--color-fill），
   它们会被注入到插件页面，让插件随主题变色。
6. fallback.css：新建时生成的兜底样式，只保证「没写到的部分仍然看得见 / 读得清」（分割线、滚动条滑块、
   进度条、Modal 遮罩、Message 卡片等纯色块元素）。由 style.css 首行那句 @import 引入。
   它的选择器全部包在 :where() 里（特异性 0），所以内置主题与你自己的规则永远压过它，它只填空缺。
   不想要就删掉那行 import（本文件可一并删除）。
7. theme.json 可选 preview：预览图**文件名数组**（相对本目录），「外观」页的主题砖会用它替代左侧色块。
   当前只取第一张（预览槽只有 40% × 112px 一块）；文件缺失时自动回落为色块。
`

interface ThemeMeta {
    name?: string
    author?: string
    description?: string
    version?: string
    inheritBuiltin?: boolean
    /** 预览图文件名列表，相对主题目录 */
    preview?: string[]
}

/**
 * `theme.json` 的 `preview` → 可直接赋 `src` 的 file:// URL 列表。
 *
 * 只接受「非空字符串」项，其余静默丢弃。
 *
 * 逐个 `isFileExists` 过滤，只把真存在的图交出去。
 */
async function toPreviewUrls(dir: string, preview: unknown): Promise<string[]> {
    if (!Array.isArray(preview)) return []
    const out: string[] = []
    for (const item of preview) {
        if (typeof item !== 'string') continue
        const name = item.trim()
        if (!name) continue
        const abs = join(dir, name)
        if (!(await isFileExists(abs))) continue
        out.push(toFileUrl(abs))
    }
    return out
}

interface ThemeStoreState {
    themes: ThemeInfo[]
    customDir: string
    loading: boolean
    load: () => Promise<void>
    refresh: () => Promise<void>
    select: (theme: ThemeInfo) => void
    create: (name: string) => Promise<Result<true>>
    remove: (theme: ThemeInfo) => Promise<boolean>
    openDir: () => Promise<void>
    openDevTools: () => Promise<void>
    reloadCurrent: () => Promise<void>
}

export const useThemeStore = create<ThemeStoreState>((set, get) => ({
    themes: BUILTIN_THEMES,
    customDir: '',
    loading: false,

    load: async () => {
        // 主题目录来自渲染端设置（`path.themesDir`），不再向主进程要完整路径。
        set({ customDir: useSettingsStore.getState().settings['path.themesDir'] })
        await get().refresh()
    },

    refresh: async () => {
        const { customDir } = get()
        set({ loading: true })
        const themes = [...BUILTIN_THEMES]
        try {
            if (customDir) {
                const entries = await listDir(customDir)
                if (!isOk(entries)) return set({ themes, loading: false })
                const dirs = entries.value.filter((e) => e.type === 'directory')
                for (const d of dirs) {
                    const jsonPath = `${d.path}/theme.json`
                    const cssPath = `${d.path}/style.css`
                    const [hasJson, hasCss] = await Promise.all([
                        isFileExists(jsonPath),
                        isFileExists(cssPath),
                    ])
                    if (!hasJson || !hasCss) continue
                    const content = await readFile(jsonPath)
                    if (!isOk(content)) continue
                    let meta: ThemeMeta = {}
                    try {
                        meta = JSON.parse(content.value) as ThemeMeta
                    } catch {
                        continue
                    }
                    // 读 style.css 解析配色，供「外观」页主题预览（读不到不影响主题本身可用）
                    const cssText = await readFile(cssPath)
                    themes.push({
                        id: `custom:${d.name}`,
                        name: meta.name || d.name,
                        builtin: false,
                        dir: d.path,
                        styleFile: cssPath,
                        inheritBuiltin: meta.inheritBuiltin ?? false,
                        author: meta.author,
                        description: meta.description,
                        version: meta.version,
                        colorVars: isOk(cssText) ? parseThemeColorVars(cssText.value) : undefined,
                        preview: await toPreviewUrls(d.path, meta.preview),
                    })
                }
            }
        } catch {
            // 目录不存在等：保持仅内置主题
        } finally {
            set({ themes, loading: false })
        }
    },

    select: (theme) => {
        useSettingsStore.getState().setSetting('theme.current', {
            dir: theme.dir,
            styleFile: theme.styleFile,
            name: theme.name,
            inheritBuiltin: theme.inheritBuiltin,
        })
        void applyTheme(theme)
    },

    create: async (name) => {
        const { customDir } = get()
        const trimmed = name.trim()
        if (!trimmed) return fail('请输入主题名称')
        if (!customDir) return fail('未设置主题目录，请先在「设置 → 路径」中配置')
        // 名称会直接当目录名用（`<主题目录>/<名称>/`）→ 先挡住文件系统非法字符。
        //    不挡的话 ensureDir 会静默建出嵌套目录（`a/b` → 两层），而列表只扫主题目录的
        //    直接子级 → 主题永远不会出现在列表里，用户看到的却是"创建成功"。
        if (/[\\/:*?"<>|]/.test(trimmed)) return fail('主题名称不能包含 \\ / : * ? " < > | 这些字符')
        const targetDir = `${customDir}/${trimmed}`
        // 两种"已存在"分开报：处理方式不同（换名字 vs 先清理那个文件夹）。
        if (await isFileExists(`${targetDir}/theme.json`)) {
            return fail(`已存在名为「${trimmed}」的主题，请换一个名称`)
        }
        if (await isFileExists(targetDir)) {
            return fail(`主题目录下已有名为「${trimmed}」的文件夹，请换一个名称或先处理它`)
        }
        const ensured = await ensureDir(targetDir)
        if (!isOk(ensured)) return fail(ensured.error)
        if (!ensured.value) return fail(`创建主题文件夹失败：${targetDir}`)
        const meta: ThemeMeta = {
            name: trimmed,
            author: '',
            description: '',
            version: '1.0.0',
            inheritBuiltin: true,
            preview: [],
        }
        const files: Array<[string, string]> = [
            ['theme.json', JSON.stringify(meta, null, 2)],
            ['style.css', THEME_STYLE_IMPORT + THEME_STYLE_TEMPLATE],
            ['fallback.css', fallbackCss],
            ['README.md', THEME_README],
        ]
        for (const [file, content] of files) {
            const w = await writeFile(`${targetDir}/${file}`, content)
            if (!isOk(w)) return fail(w.error)
            if (!w.value) return fail(`写入 ${file} 失败：${targetDir}/${file}`)
        }
        await get().refresh()
        return ok(true)
    },

    remove: async (theme) => {
        if (theme.builtin) return false
        // 删除当前选中主题：先回退到内置，再删目录。
        if (useSettingsStore.getState().settings['theme.current'].styleFile === theme.styleFile) {
            useSettingsStore.getState().setSetting('theme.current', {
                dir: '',
                styleFile: '',
                name: 'light',
                inheritBuiltin: false,
            })
            void applyTheme({ name: 'light', styleFile: '', inheritBuiltin: false })
        }
        const del = await deleteDirectory(theme.dir)
        if (!isOk(del) || !del.value) return false
        await get().refresh()
        return true
    },

    openDir: async () => {
        // 打开当前主题所在目录。
        // 当前主题目录直接取 `theme.current.dir`（`select()` 时写入的该主题目录）。
        // 内置主题回退到主题根目录。
        const cur = useSettingsStore.getState().settings['theme.current']
        const dir = cur.dir || get().customDir
        if (dir) await openDirInExplorer(dir)
    },

    openDevTools: async () => {
        await invoke('mainWindow:openDevTools')
    },

    reloadCurrent: async () => {
        reloadCustomTheme()
    },
}))
