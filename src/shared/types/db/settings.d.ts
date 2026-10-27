declare namespace LP {
    /**
     * 存储于主进程 sqlite main_settings 表
     */
    interface MainSetting {
        /** 主窗位置与尺寸 */
        'mainWindow.bounds': {
            width: number
            height: number
            x: number | 'center'
            y: number | 'center'
        }

        /** 桌面歌词窗位置与尺寸 */
        'desktopLyricWindow.bounds': {
            width: number
            height: number
            x: number | 'center'
            y: number | 'center'
        }

        /** 关闭窗口时最小化到托盘而非退出 */
        'window.closeToTray': boolean

        /**
         * 窗口背景材质（仅 Windows 生效）：无 / Mica / Acrylic / Tabbed。
         * Mica / Tabbed 需 Windows 11，Acrylic 在 Windows 10 及以上可用；非 Windows 平台界面自动隐藏该组。
         */
        'window.backgroundMaterial': 'none' | 'mica' | 'acrylic' | 'tabbed'

        'application.debug.enable': boolean
    }

    /**
     * 存储于渲染端 localStorage 的设置
     */
    interface RendererSetting {
        /**
         * 音量，0 - 1，两位小数
         */
        'player.audio.volume': number
        /**
         * 播放速率，0.5 - 2.0，二位小数
         */
        'player.audio.rate': number
        /**
         * 播放模式，循环、单曲重复、随机
         */
        'player.mode': 'loop' | 'single' | 'random'
        /**
         * 优先播放音质
         * 「首选 + 就近回退」：在 <= 该档的可用音质里取最高的一档；
         * 当歌曲只有更高档（例如设了 Standard 而歌曲只有 Master）时向上取最接近的一档。
         */
        'player.preferredQuality': Quality
        /**
         * 播放失败时自动切到下一首。
         * 只有「歌源本身播不了」才跳（排除 AbortError / NotAllowedError / MEDIA_ERR_ABORTED）；
         * 连续失败达上限即停止自动切换（见 `features/player/autoSkip.ts`）。
         */
        'player.autoSkipOnError': boolean

        /**
         * 是否优先尝试下载较高音质（母带/Hi-Res/SQ...）；
         * 关闭时固定选择标准音质（Standard）。仅在未显式指定音质时生效。
         */
        'download.preferHigherQuality': boolean

        /**
         * 下载文件名格式。同一选项既用于生成下载文件名，也用于解析本地文件名。
         *
         * 四种格式的专辑段都可省略：没有专辑信息时生成侧退化成 `歌手 - 歌名`
         * （`name-` 系退化成 `歌名 - 歌手`）、不留孤儿分隔符。
         */
        'download.fileNameFormat':
            | 'singer_album-name' // 歌手_专辑 - 歌名（默认）
            | 'name-singer_album' // 歌名 - 歌手_专辑
            | 'singer-name(album)' // 歌手 - 歌名（专辑）
            | 'name-singer(album)' // 歌名 - 歌手（专辑）

        /**
         * 本地文件存在性检查的启动全量扫描间隔（节流窗口）。启动时若距上次全量扫描
         * 不足这个长度，就不重跑全量、只复查已标记为缺失的路径（这样「用户把文件放回去了」
         * 也能被发现）。
         *
         * ⚠️ 它只管「启动扫描」这一件事：`'never'` = 永不全量，但仍会沿用上次的检查结论
         * （照灰）、运行期发现的缺失照记。
         * ⚠️ 只在启动时读一次，改动要重启才生效。
         * 「文件是否存在」最终仍由播放那一刻判定（`playFrom` / `getSongLink` 的校验），与本项无关。
         */
        'localFile.checkInterval':
            | '6h' // 6 小时（默认）
            | '1d' // 1 天
            | '3d' // 3 天
            | 'never' // 从不扫描

        /**
         * 当前主题信息
         */
        'theme.current': {
            /**
             * 主题目录路径
             */
            dir: string
            /**
             * 主题样式文件路径
             */
            styleFile: string
            /**
             * 主题名称
             */
            name: string
            /**
             * 是否继承内置主题作为兜底底座
             */
            inheritBuiltin?: boolean
        }

        /**
         * 内置主题方案：浅色 / 深色 / 跟随系统
         */
        'theme.builtinScheme': 'light' | 'dark' | 'system'

        /**
         * 应用内快捷键设置
         */
        'hotkey.local': {
            /**
             * 上一首
             */
            previous: string
            /**
             * 下一首
             */
            next: string
            /**
             * 音量加
             */
            volumeUp: string
            /**
             * 音量减
             */
            volumeDown: string

            /**
             * 前进
             */
            forward: string
            /**
             * 倒带
             */
            rewind: string

            /**
             * 播放/暂停 切换
             */
            togglePlay: string
        }
        /**
         * 是否启用全局快捷键
         */
        'hotkey.global.enable': boolean
        'hotkey.global': {
            previous: string
            next: string
            volumeUp: string
            volumeDown: string

            togglePlay: string
            toggleWindowShow: string
        }

        /** 是否响应多媒体键（键盘上的播放/暂停、上一首、下一首媒体键） */
        'hotkey.mediaKeys.enable': boolean

        /**
         * 导航栏是否展开
         */
        'ui.navbarExpanded': boolean

        /**
         * 搜索框空闲时，标题栏搜索区是否显示当前歌曲状态（与搜索框共占一格、让位显示）。
         * 悬停搜索区 / 聚焦 / 有输入文字时恢复搜索框。
         */
        'appearance.titlebar.showSongStatus': boolean

        /**
         * 播放控制栏是否显示歌词预览
         */
        'appearance.control.showLyricPreview': boolean

        /**
         * 是否启用界面动效（过渡 / 动画）。关闭后全局禁用，等价于强制 reduced-motion。
         */
        'appearance.motion.enabled': boolean

        /**
         * 桌面歌词配色方案：已唱 / 未唱
         */
        'desktopLyric.colorPalette': {
            played: string
            unplayed: string
        }
        /**
         * 桌面歌词字体设置
         */
        'desktopLyric.font': {
            family: string
            size: number
        }
        /**
         * 主歌词行下方的辅助行：不显示 / 显示翻译 / 显示罗马音
         */
        'desktopLyric.secondaryLine': 'none' | 'translation' | 'roma'
        /**
         * 桌面歌词显示行数
         */
        'desktopLyric.lineCount': 1 | 2
        /**
         * 桌面歌词对齐方式：'alternate' 为双行下的左右分离，'center' 为居中
         */
        'desktopLyric.align': 'center' | 'alternate'

        /**
         * 用户歌单排列顺序（存储歌单 ID 数组）
         */
        'playlist.order': string[]

        /**
         * 歌单未设置封面时，自动使用并保存歌曲列表中首个有效封面
         */
        'playlist.useSongCoverAsFallback': boolean

        /** 列表行内显示「来源标签」 */
        'playlist.showPluginTag': boolean
        /** 列表行内显示「音质标签」（取该曲支持的最高非 Standard 档） */
        'playlist.showQualityTag': boolean

        /**
         * 本次运行的应用版本号 = `package.json` 的 version（主进程 `app:getVersion` 对齐）。
         *
         * 同时充当升级检测：启动时与盘上值比对，不相等就说明「刚从旧版本升上来」，
         * 盘上那个值就是升级前的版本；升级逻辑写在那个分支里，末尾写入当前版本 ⇒ 只跑一趟。
         * 空串 = 从未运行过（首启判定读它）。关于页展示也读它。
         */
        'application.version': string

        /** 自动下载新版本 */
        'update.autoDownload': boolean

        /**
         * 更新后显示更新日志。
         * 启动时比对 application.version 发现版本变化（= 刚升级过），开启则弹出本次更新内容。
         */
        'update.showChangelogAfterUpdate': boolean

        /**
         * 缓存目录（封面等缓存文件落盘处）。空串 = 尚未初始化（首启由 main.tsx 填充）。
         */
        'path.cacheDir': string
        /**
         * 下载目录。默认取系统下载目录。空串 = 尚未初始化。
         */
        'path.downloadDir': string
        /**
         * 用户自定义主题目录。空串 = 尚未初始化。
         */
        'path.themesDir': string
        /**
         * 用户数据根目录（等价 Electron `app.getPath('userData')`）。空串 = 尚未初始化。
         */
        'path.rootDir': string
    }
}
