/** 插件生命周期状态 */
type PluginState = 'installed' | 'active' | 'inactive' | 'error'

/** 插件激活时机 */
type PluginActivationEvent = '*' | 'onStartup' | `onCommand:${string}` | `onEvent:${string}`

interface PluginCommandContribution {
    command: string
    title: string
}

interface PluginMenuContribution {
    command: string
    location: string
    /**
     * 显示条件表达式（Context Key 机制），如 "menu.selectionCount == 1"。
     */
    when?: string
    /** SVG 图标文件相对路径（相对于插件目录），如 "icons/star.svg" */
    icon?: string
}

/**
 * 插件视图贡献点。
 * 所有「插件作者写的 HTML 嵌入宿主」统称 View，由 container 决定渲染位置：
 * - modal：Modal 弹层
 * - settings：设置路由（/settings/plugin-settings/:id?view=<viewId>）
 * entryUrl 为 entry 经插件目录解析后的绝对 file:// URL（运行时注入，渲染端零路径处理）。
 */
interface PluginViewContribution {
    /** 视图唯一 ID（插件内全局唯一），建议命名空间：xxx.modal / xxx.settings */
    id: string
    /** UI 语义标题（Modal 标题 / 页面标题 / 导航 label） */
    title?: string
    /** 入口 HTML 相对插件目录路径 */
    entry: string
    /** 渲染位置 */
    container: 'modal' | 'settings'
    /** 仅 modal：面板尺寸，缺省 480×360 */
    size?: { width: number; height: number }
    /** 仅 modal：是否允许 ESC / 点遮罩关闭，缺省 true */
    escClose?: boolean
    /** 运行时注入：归属插件 ID（由 getContributions / getPlugins 聚合时补） */
    pluginId: string
    /** 运行时注入：entry 经插件目录解析后的绝对 file:// URL（渲染端零路径处理） */
    entryUrl: string
}

/** lp.ui.showView() 运行时选项（仅 modal 生效） */
interface PluginShowViewOptions {
    /** 是否允许按 ESC / 点遮罩关闭视图。缺省回退到 manifest 的 views[].escClose，再缺省 true */
    escClose?: boolean
    /** 初始载荷：iframe 触发 onLoad 后由宿主随 lp:init 下发给视图（需可结构化克隆） */
    data?: unknown
}

/** lp.ui.showView() / lpView.open() 的结果 */
type ShowViewResult =
    | { status: 'opened'; reused?: true }
    | {
          status: 'rejected'
          reason: 'occupied' | 'unknown-view'
          occupant?: { pluginId: string; viewId: string }
      }

/** lp.ui.closeView() / lpView.close() 的结果 */
type CloseViewResult =
    | { status: 'closed' }
    | { status: 'rejected'; reason: 'not-open' | 'not-closable' }

/** 视图被动关闭的原因（广播给插件后端） */
type ViewCloseReason = 'user' | 'api' | 'view'

/** 跨边界的统一事件结构（视图 ⇄ 插件后端） */
interface ViewEvent<P = unknown> {
    action: string
    payload: P
    /** 归属插件 */
    pluginId: string
    /** 来源视图（后端侧）/ 目标视图（视图侧） */
    viewId: string
    /** 宿主打的戳 */
    timestamp: number
}

interface PluginProviderContribution {
    /** 目标插件 ID */
    targetPlugin: string
    /** 目标命令名 */
    command: string
    /** 人类可读标题（用于设置页显示） */
    title?: string
}

/** 插件命令与 Provider 的启停配置 */
interface PluginConfig {
    /** 被禁用的命令列表 */
    disabledCommands?: string[]
    /** 被禁用的 Provider 列表，格式: "targetPluginId:command" */
    disabledProviders?: string[]
}

/** plugin.json 的完整结构 */
interface PluginManifest {
    id: string
    name: string
    /** 插件标识 */
    label?: string
    /**
     * 插件图标文件相对路径（相对于插件目录），如 "icon.png" / "icons/logo.svg"。
     * 支持 svg / png / jpg 等浏览器可解码的格式；缺省则界面只显示插件名。
     */
    icon?: string
    version: string
    description?: string
    author?: string
    homePage?: string
    updateTime?: string
    main: string
    activationEvents: PluginActivationEvent[]
    contributions?: {
        commands?: PluginCommandContribution[]
        providers?: PluginProviderContribution[]
        menus?: PluginMenuContribution[]
        views?: PluginViewContribution[]
    }
}

/** 运行时插件信息 = manifest + 数据库持久状态，由 PluginHost.getPlugins() 返回给 renderer */
interface PluginInfo {
    id: string
    name: string
    label?: string
    /** 图标文件相对路径（manifest 原样透传，渲染端不消费；渲染用 iconUrl） */
    icon?: string
    /** 运行时注入：icon 经插件目录解析后的绝对 file:// URL；无 icon 或解析失败时缺省 */
    iconUrl?: string
    version: string
    description?: string
    author?: string
    homePage?: string
    updateTime?: string
    enabled: boolean
    state: PluginState
    error?: string
    dirPath: string
    installedAt?: string
    updatedAt?: string
    /** 该插件声明的命令列表 */
    commands: PluginCommandContribution[]
    /** 该插件声明的 Provider 列表 */
    providers: PluginProviderContribution[]
    /** 该插件声明的视图列表（含运行时注入的 entryUrl） */
    views?: PluginViewContribution[]
    /** 命令与 Provider 启停配置 */
    config: PluginConfig
}

/** 音乐源协议类型（嵌套于 LP.Plugin 命名空间，与 db/plugin.d.ts 的 LP.Plugin 行接口合并） */
declare namespace LP {
    namespace Plugin {
        interface Song {
            /** 歌曲在插件中的原始 ID */
            id: string
            /** 歌曲名称 */
            name: string
            album: {
                id?: string
                name: string
                [property: string]: unknown
            }
            singer: {
                id?: string
                name: string
                [property: string]: unknown
            }[]
            /** 歌曲时长，单位秒 */
            duration: number
            /** 歌曲图片 URL */
            pic?: string
            /** 歌曲可用的音质信息 */
            supportQualities: {
                type: Quality
                size?: string | number
                [property: string]: unknown
            }[]
            /** 来源插件标识 */
            pluginId: string
            [property: string]: unknown
        }

        interface SongLyric {
            /** lrc 格式歌词文本 */
            lyric: string
            /** 翻译歌词文本 */
            tlyric?: string
            /** 卡拉ok逐字歌词 */
            klyric?: {
                start: number
                duration: number
                words: {
                    start: number
                    duration: number
                    word: string
                }[]
            }[]
            /** 罗马拼音歌词文本 */
            rlyric?: string | {
                start: number
                duration: number
                words: {
                    start: number
                    duration: number
                    word: string
                }[]
            }[]
        }

        interface Playlist {
            /** 歌单名称 */
            name: string
            /** 歌单描述 */
            description?: string
            /** 歌单图片 URL */
            pic?: string
            /** 来源插件标识 */
            pluginId: string
            [property: string]: unknown
        }
    }
}
