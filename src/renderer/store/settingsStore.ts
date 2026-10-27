import { create } from 'zustand'
import { persist, type PersistStorage } from 'zustand/middleware'
import { join } from '@shared/utils'
import { invoke } from '@renderer/lib/ipc'
import { ensureDir } from '@renderer/lib/file'

// 设置落盘（localStorage）的防抖延迟。
 const PERSIST_DELAY = 300
const RS_PREFIX = 'rs:'

/**
 * 渲染端设置持久化：每设置一个独立 localStorage 键（前缀 `rs:`），
 * 把本地存储当 main_settings 表用，与主进程 `{id:key, value}` 行模型对称。
 *
 * 三条不变量（改这个函数前先读；判据见 `.verify/settings-write-isolation/`）：
 * 1. 逐键 diff：只有「序列化结果与盘上不同」的键才进 `pending` → 写一项不会覆盖其他项。
 * 2. 值引用未变则整键跳过（连序列化都省）。代价：设置值必须当不可变用 —— 就地改
 *    （`arr.push`）不换引用，会被判成「没变」而丢掉写入。现有调用方全是展开新建。
 * 3. 落盘逐键隔离：某个键写失败（典型是配额）不连累同批其他键，且清掉它的引用记忆
 *    → 下一次任意设置写入都会重新尝试它，而不是静默丢掉。
 */
function makeSettingsStorage(delay: number): PersistStorage<{ settings: LP.RendererSetting }> {
    /** 已成功落盘（或 hydrate 时读到）的序列化结果 —— diff 与「要不要写」的判据 */
    const writtenCache: Record<string, string> = {}
    /** 上次过手时的值引用 —— 与当前引用一致即整键跳过（见不变量 2） */
    const seenValue: Record<string, unknown> = {}
    /** 已报告过写入失败的键，避免每 300ms 刷一条 */
    const reported = new Set<string>()
    let timer: number | null = null
    let pending: Record<string, string> | null = null

    const flush = () => {
        if (timer !== null) {
            window.clearTimeout(timer)
            timer = null
        }
        if (!pending) return
        const batch = pending
        pending = null
        for (const sk in batch) {
            try {
                localStorage.setItem(sk, batch[sk])
                writtenCache[sk] = batch[sk]
                reported.delete(sk)
            } catch (e) {
                // 单键隔离：一个键写不进去不能连累同批其他键
                // 清掉引用记忆 → 该键下次仍会被判为「有变化」，从而重试。
                delete seenValue[sk]
                if (!reported.has(sk)) {
                    reported.add(sk)
                }
            }
        }
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('pagehide', flush)
        window.addEventListener('beforeunload', flush)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush()
        })
    }

    const write = (settings: LP.RendererSetting) => {
        pending = pending ?? {}
        let changed = false
        for (const key of Object.keys(settings) as (keyof LP.RendererSetting)[]) {
            const sk = RS_PREFIX + key
            const value = settings[key]
            // 引用未变 → 序列化结果必然与上次相同：整键跳过
            if (Object.is(seenValue[sk], value)) continue
            seenValue[sk] = value
            const s = JSON.stringify(value)
            if (writtenCache[sk] === s) {
                delete pending[sk]
                continue
            }
            pending[sk] = s
            changed = true
        }
        if (!changed) return
        if (timer !== null) window.clearTimeout(timer)
        timer = window.setTimeout(flush, delay)
    }

    return {
        getItem: () => {
            const defaults = getDefaultRendererSettings()
            const settings = {} as LP.RendererSetting
            const target = settings as unknown as Record<string, unknown>
            for (const key of Object.keys(defaults) as (keyof LP.RendererSetting)[]) {
                const sk = RS_PREFIX + key
                const raw = localStorage.getItem(sk)
                if (raw !== null) {
                    // 盘上已有：以盘上为准，绝不覆盖用户改过的值。
                    // getItem 跑在 create() 期间，「读不出来就抛」等于整个
                    // settingsStore 起不来。值被写坏时回落默认值，并由下面的 cache 差异自愈。
                    try {
                        target[key] = JSON.parse(raw)
                    } catch (e) {
                        target[key] = defaults[key]
                    }
                    writtenCache[sk] = raw
                    seenValue[sk] = target[key]
                    continue
                }
                // 盘上缺失（新增设置项 / 首次运行）：补一条默认值。
                // 这里必须真写盘 —— 只放内存的话，用户若不改这一项，它就永远不落盘。
                const serialized = JSON.stringify(defaults[key])
                try {
                    localStorage.setItem(sk, serialized)
                } catch (e) {
                    // 配额满 / 存储被禁：内存里照用默认值，落盘留给后续写入重试。
                }
                target[key] = defaults[key]
                writtenCache[sk] = serialized
                seenValue[sk] = defaults[key]
            }
            return { state: { settings }, version: 1 }
        },
        setItem: (_name, value) => {
            write(value.state.settings)
        },
        removeItem: () => {
            if (timer !== null) {
                window.clearTimeout(timer)
                timer = null
            }
            pending = null
            for (const sk in writtenCache) {
                localStorage.removeItem(sk)
                delete writtenCache[sk]
            }
            // 引用记忆同样要清：否则清空后写回「与清空前一模一样的值」会被判成没变而不落盘
            for (const sk of Object.keys(seenValue)) delete seenValue[sk]
            reported.clear()
            const defaults = getDefaultRendererSettings()
            for (const key of Object.keys(defaults)) localStorage.removeItem(RS_PREFIX + key)
        },
    }
}

/**
 * 渲染端默认设置工厂
 */
export function getDefaultRendererSettings(): LP.RendererSetting {
    return {
        'player.audio.volume': 0.7,
        'player.audio.rate': 1,
        'player.mode': 'loop',
        'player.preferredQuality': 'Standard',
        'player.autoSkipOnError': true,
        'download.preferHigherQuality': false,
        'download.fileNameFormat': 'singer_album-name',
        // 本地文件检查的扫描间隔（节流窗口）—— 详见 LP.RendererSetting 里该键的注释
        'localFile.checkInterval': '6h',

        'theme.current': {
            dir: '',
            styleFile: '',
            name: '',
            inheritBuiltin: false,
        },
        'theme.builtinScheme': 'system',

        'hotkey.local': {
            previous: 'CommandOrControl+Left', // Ctrl + ←
            next: 'CommandOrControl+Right', // Ctrl + →
            volumeUp: 'CommandOrControl+Up', // Ctrl + ↑
            volumeDown: 'CommandOrControl+Down', // Ctrl + ↓

            forward: 'Right', // →
            rewind: 'Left', // ←

            togglePlay: 'Space', // 空格
        },
        'hotkey.global.enable': false,
        'hotkey.global': {
            previous: 'CommandOrControl+Alt+Left', // Ctrl + Alt + ←
            next: 'CommandOrControl+Alt+Right', // Ctrl + Alt + →
            volumeUp: 'CommandOrControl+Alt+Up', // Ctrl + Alt + ↑
            volumeDown: 'CommandOrControl+Alt+Down', // Ctrl + Alt + ↓

            togglePlay: 'CommandOrControl+Alt+P', // Ctrl + Alt + P
            toggleWindowShow: 'CommandOrControl+Alt+W', // Ctrl + Alt + W
        },
        'hotkey.mediaKeys.enable': false,

        'desktopLyric.colorPalette': {
            played: '#B24BF3',
            unplayed: '#E0C3FC'
        },
        'desktopLyric.font': {
            family: 'system-ui',
            size: 28
        },
        'desktopLyric.secondaryLine': 'none',
        'desktopLyric.lineCount': 2,
        'desktopLyric.align': 'alternate',

        'ui.navbarExpanded': true,
        'appearance.titlebar.showSongStatus': false,
        'appearance.control.showLyricPreview': false,
        'appearance.motion.enabled': true,
        'playlist.order': [],
        'playlist.useSongCoverAsFallback': true,
        'playlist.showPluginTag': true,
        'playlist.showQualityTag': true,

        // 版本记录。空串 = 从未运行过（首启判定）；与当前版本不等 = 刚升级，差的就是升级前的版本。
        'application.version': '',

        // 自动下载 / 更新后弹更新日志
        'update.autoDownload': true,
        'update.showChangelogAfterUpdate': true,

        // 路径设置：默认值只能是空串 —— 具体路径依赖主进程给的原始素材
        // （`app:getPathMaterial`：userData / home / downloads），而默认值工厂在
        // 模块加载时就会跑（`getItem()` 补写缺失键），那时拿不到素材、也不能 await。
        // 空串在语义上 = 「尚未初始化」，由 main.tsx 首启时用素材拼出来落盘。
        'path.cacheDir': '',
        'path.downloadDir': '',
        'path.themesDir': '',
        'path.rootDir': '',
    }
}

// ============================================================
// 路径设置：主进程只给素材，渲染端拼 + 存渲染端设置
// ============================================================

/**
 * 主进程给的「拼路径素材」：系统决定的那几个位置，本身不是用户可配置项。
 * 渲染端不落盘保存它们，只在需要时（首启拼默认路径 / 用户重置为默认值）现取现用。
 */
interface PathMaterial {
    /** Electron `app.getPath('userData')` */
    userData: string
    /** 系统用户主目录 */
    home: string
    /** 系统下载目录 */
    downloads: string
}

/** 四个路径键 */
export const PATH_KEYS = [
    'path.cacheDir',
    'path.downloadDir',
    'path.themesDir',
    'path.rootDir',
] as const

/**
 * 由素材拼出四个路径的默认值（与老项目基线对齐）。
 * 返回的键集合与 `PATH_KEYS` 一致，可直接喂给 `setSettings`。
 */
function buildDefaultPaths(m: PathMaterial): Pick<LP.RendererSetting, (typeof PATH_KEYS)[number]> {
    return {
        'path.cacheDir': join(m.userData, 'cache'),
        'path.downloadDir': join(m.downloads),
        'path.themesDir': join(m.userData, 'themes'),
        'path.rootDir': join(m.userData),
    }
}

/**
 * 初始化路径设置。
 *
 * 只填空串的键 → 用户改过的一律不覆盖；拼完即落盘。
 */
export async function initPathSettings(): Promise<void> {
    const { settings, setSettings } = useSettingsStore.getState()
    if (!PATH_KEYS.some((k) => !settings[k])) return
    const material = await invoke<PathMaterial>('app:getPathMaterial').catch(() => null)
    if (!material) return
    const defaults = buildDefaultPaths(material)
    const patch: Partial<LP.RendererSetting> = {}
    for (const k of PATH_KEYS) {
        if (!settings[k]) patch[k] = defaults[k] as never
    }
    setSettings(patch)
}

/** 确保三个路径目录存在，`rootDir` 即 userData 本身 */
export async function ensurePathDirs(): Promise<void> {
    const { 'path.cacheDir': cacheDir, 'path.downloadDir': downloadDir, 'path.themesDir': themesDir } =
        useSettingsStore.getState().settings
    await Promise.all([cacheDir, downloadDir, themesDir].filter(Boolean).map((dir) => ensureDir(dir)))
}

type SettingsState = {
    settings: LP.RendererSetting
    setSetting: <K extends keyof LP.RendererSetting>(k: K, v: LP.RendererSetting[K]) => void
    setSettings: (patch: Partial<LP.RendererSetting>) => void
}

export const useSettingsStore = create<SettingsState>()(
    persist(
        (set) => ({
            settings: getDefaultRendererSettings(),
            setSetting: (k, v) => set((s) => ({ settings: { ...s.settings, [k]: v } })),
            setSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
        }),
        {
            name: 'rs-settings',
            version: 1,
            storage: makeSettingsStorage(PERSIST_DELAY),
            partialize: (state) => ({ settings: state.settings }),
            merge: (persisted, current) => ({
                ...current,
                settings: { ...current.settings, ...(persisted as { settings?: LP.RendererSetting })?.settings },
            }),
        },
    ),
)
