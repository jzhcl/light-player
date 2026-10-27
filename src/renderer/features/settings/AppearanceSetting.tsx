import { useEffect, useRef, useState } from 'react'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Icon } from '@renderer/components/Icon'
import { Popover } from '@renderer/components/ui/Popover'
import { Select } from '@renderer/components/ui/Select'
import { useSettingsStore } from '@renderer/store'
import { useThemeStore, type ThemeInfo } from '@renderer/store/themeStore'
import { resolveThemeColors } from '@renderer/hooks/useTheme'
import { invokeResult } from '@renderer/lib/ipc'
import { isFileExists } from '@renderer/lib/file'
import { message } from '@renderer/lib/message'
import { rlog } from '@renderer/lib/log'
import { isOk } from '@shared/result'

/** 窗口背景材质取值 */
type BackgroundMaterial = LP.MainSetting['window.backgroundMaterial']

type BuiltinScheme = 'light' | 'dark' | 'system'

/** 主题砖上的删除按钮 */
function ThemeDeleteButton({
    theme,
    open,
    onOpenChange,
    onRemove,
}: {
    theme: ThemeInfo
    open: boolean
    onOpenChange: (open: boolean) => void
    onRemove: () => void
}) {
    const anchorRef = useRef<HTMLButtonElement>(null)
    return (
        <Popover
            open={open}
            onOpenChange={onOpenChange}
            side="top"
            align="center"
            anchorRef={anchorRef}
            anchor={
                <button
                    ref={anchorRef}
                    type="button"
                    className="icon-button center theme-del-btn"
                    title="删除主题"
                    aria-label={`删除主题「${theme.name}」`}
                    onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onOpenChange(!open)
                    }}
                >
                    <Icon name="trash" size={14} />
                </button>
            }
        >
            <div className="popover-confirm">
                <div className="popover-confirm-text">确认删除主题「{theme.name}」？</div>
                <div className="popover-confirm-actions">
                    <button
                        type="button"
                        className="popover-confirm-cancel"
                        onClick={() => onOpenChange(false)}
                    >
                        取消
                    </button>
                    <button type="button" className="popover-confirm-ok" onClick={onRemove}>
                        删除
                    </button>
                </div>
            </div>
        </Popover>
    )
}


export function AppearanceSetting() {
    const themes = useThemeStore((s) => s.themes)
    const loading = useThemeStore((s) => s.loading)
    const load = useThemeStore((s) => s.load)
    const refresh = useThemeStore((s) => s.refresh)
    const select = useThemeStore((s) => s.select)
    const createTheme = useThemeStore((s) => s.create)
    const removeTheme = useThemeStore((s) => s.remove)
    const openDir = useThemeStore((s) => s.openDir)
    const openDevTools = useThemeStore((s) => s.openDevTools)
    const reloadCurrent = useThemeStore((s) => s.reloadCurrent)

    const current = useSettingsStore((s) => s.settings['theme.current'])
    const builtinScheme = useSettingsStore((s) => s.settings['theme.builtinScheme'])
    const showSongStatus = useSettingsStore((s) => s.settings['appearance.titlebar.showSongStatus'])
    const showLyricPreview = useSettingsStore((s) => s.settings['appearance.control.showLyricPreview'])
    const motionEnabled = useSettingsStore((s) => s.settings['appearance.motion.enabled'])
    const setSetting = useSettingsStore((s) => s.setSetting)

    // 窗口背景材质是主进程设置，需经 IPC 读写。
    const [backgroundMaterial, setBackgroundMaterial] = useState<BackgroundMaterial>('none')
    const [materialLoading, setMaterialLoading] = useState(true)

    useEffect(() => {
        void (async () => {
            const r = await invokeResult<BackgroundMaterial>('settings:get', 'window.backgroundMaterial')
            if (isOk(r)) setBackgroundMaterial(r.value)
            setMaterialLoading(false)
        })()
    }, [])

    const handleBackgroundMaterial = async (v: BackgroundMaterial) => {
        const prev = backgroundMaterial
        setBackgroundMaterial(v)
        // 主进程写入后会立即把材质套用到窗口
        const r = await invokeResult<true>('settings:set', 'window.backgroundMaterial', v)
        if (!isOk(r)) {
            setBackgroundMaterial(prev) // 写回失败则回滚 UI
        }
    }

    // 背景材质为 Windows 专属能力，非 Windows 仅展示说明
    const IS_WINDOWS = /win/i.test(navigator.platform || navigator.userAgent)

    // creating 控制展开/收起（宽度 + 内部淡入淡出过渡）；输入框常驻 DOM，靠 CSS 显隐避免 display 不可动画。
    const [creating, setCreating] = useState(false)
    const [name, setName] = useState('')
    const [confirmingId, setConfirmingId] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // 「当前主题的样式文件不存在了」每次进页面只报一次
    const themeMissingReported = useRef(false)

    useEffect(() => {
        void (async () => {
            await load()
            // 主题砖列表只列出「theme.json + style.css 都在」的目录 —— 当前主题一被删，
            // 它就从列表里消失了：于是没有任何一块砖是选中的，页面上却看不出为什么。
            const cur = useSettingsStore.getState().settings['theme.current']
            if (!cur.styleFile || themeMissingReported.current) return
            if (await isFileExists(cur.styleFile)) return
            themeMissingReported.current = true
            rlog.error(`[theme] 当前主题的样式文件已丢失：${cur.name}（${cur.styleFile}）`)
            message.warn(
                `主题「${cur.name}」的样式文件已丢失，页面已退回内置配色；请重新选择主题或检查主题目录`,
            )
        })()
    }, [load])

    useEffect(() => {
        // ⚠️ 必须 preventScroll：展开动画期间输入框刚被插进一个宽度还在过渡的容器里，
        // 浏览器默认会为了"把焦点元素带进视口"去滚最近的滚动祖先（含 overflow:hidden 的容器）
        // → 内容被额外位移、再随容器变宽被 clamp 回去，动画就成了双重运动（手感"卡一下"）。
        if (creating) inputRef.current?.focus({ preventScroll: true })
    }, [creating])

    const isActive = (t: ThemeInfo) =>
        t.builtin ? !current.styleFile : current.styleFile === t.styleFile

    const startCreate = () => {
        setCreating(true)
    }
    const cancelCreate = () => {
        setCreating(false)
        setName('')
    }
    const handleCreate = async () => {
        const r = await createTheme(name)
        if (!isOk(r)) {
            message.error(r.error)
            return
        }
        cancelCreate()
    }

    const handleRemove = async (t: ThemeInfo) => {
        const done = await removeTheme(t)
        if (done) {
            setConfirmingId(null)
            return
        }
        message.error(`删除主题「${t.name}」失败，请检查主题目录是否可写`)
    }

    const currentHasStyle = !!current.styleFile
    const onlyBuiltin = themes.length <= 1

    // 切换内置主题方案：写设置并切到内置主题立即生效
    const handleSchemeChange = (v: BuiltinScheme) => {
        setSetting('theme.builtinScheme', v)
        const builtin = themes.find((t) => t.builtin)
        if (builtin) select(builtin)
    }

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">主题</h2>
                    <div className="settings-toolbar">
                        <div className={`theme-create-wrapper${creating ? ' is-creating' : ''}`}>
                            <button
                                type="button"
                                className="theme-create-trigger icon-button center icon-button--sm"
                                title="新建主题"
                                onClick={startCreate}
                            >
                                <Icon name="add" />
                            </button>
                            <div className="theme-create-field">
                                <input
                                    ref={inputRef}
                                    className="settings-input theme-input"
                                    placeholder="输入主题名称"
                                    value={name}
                                    onChange={(e) => setName(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void handleCreate()
                                        if (e.key === 'Escape') cancelCreate()
                                    }}
                                    onBlur={cancelCreate}
                                />
                                <button
                                    type="button"
                                    className="theme-create-confirm icon-button center icon-button--sm"
                                    title="创建"
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => void handleCreate()}
                                >
                                    <Icon name="check-lg" />
                                </button>
                            </div>
                        </div>

                        <button
                            type="button"
                            className="icon-button center icon-button--sm"
                            title={
                                current.dir
                                    ? '在文件管理器中打开当前主题的目录'
                                    : '在文件管理器中打开主题目录'
                            }
                            onClick={() => void openDir()}
                        >
                            <Icon name="folder" />
                        </button>
                        <button
                            type="button"
                            className="icon-button center icon-button--sm"
                            title="重新加载当前主题"
                            disabled={!currentHasStyle}
                            onClick={() => void reloadCurrent()}
                        >
                            <Icon name="reload" />
                        </button>
                        <button
                            type="button"
                            className="icon-button center icon-button--sm"
                            title="刷新主题列表"
                            disabled={loading}
                            onClick={() => void refresh()}
                        >
                            <span className={loading ? 'spin' : undefined}>
                                <Icon name="refresh" />
                            </span>
                        </button>
                        <button
                            type="button"
                            className="icon-button center icon-button--sm"
                            title="打开开发者工具"
                            onClick={() => void openDevTools()}
                        >
                            <Icon name="code" />
                        </button>
                    </div>
                </header>
                <div className="settings-group-body">
                    <div className="theme-grid">
                        {themes.map((t) => {
                            const active = isActive(t)
                            // 只取该砖那块主题的两个色（fill / primary）；其余一切跟随当前主题
                            const c = resolveThemeColors(t.colorVars)
                            const desc = t.builtin
                                ? '自动匹配系统浅色 / 深色模式'
                                : [t.author, t.description].filter(Boolean).join(' · ') || '自定义主题'
                            return (
                                <div
                                    key={t.id}
                                    className={`theme-tile${active ? ' is-active' : ''}`}
                                    onClick={() => select(t)}
                                >
                                    {/* 预览槽：主题给了预览图就用图（铺满裁切），没给则铺该主题的画布色。
                                        ⚠️ 只取首张 —— 槽只有 40% × 112px 一块；`preview` 存的是数组，
                                        多图留给将来（悬停切换 / 大图预览）。 */}
                                    <div className="theme-tile-preview" style={{ backgroundColor: c.fill }}>
                                        {t.preview[0] && (
                                            <img
                                                className="theme-tile-preview-img"
                                                src={t.preview[0]}
                                                alt=""
                                                draggable={false}
                                            />
                                        )}
                                    </div>
                                    <div className="theme-tile-body">
                                        <div className="theme-tile-head">
                                            {/* 名称与描述都可能被 ellipsis 截断 → 一律挂 title */}
                                            <span className="theme-tile-name" title={t.name}>
                                                {t.name}
                                            </span>
                                            {t.version && (
                                                <span className="theme-tile-version">
                                                    {t.version}
                                                </span>
                                            )}
                                            <span className="theme-tile-grow" />
                                            {active && (
                                                <span className="theme-tile-check">
                                                    <Icon name="check-circle" />
                                                </span>
                                            )}
                                        </div>
                                        <p className="theme-tile-desc" title={desc}>
                                            {desc}
                                        </p>
                                        <div className="theme-tile-foot">
                                            <span className="theme-tile-accent" style={{ backgroundColor: c.primary }} />
                                            <span className="theme-tile-grow" />
                                            {/* 内置主题的浅/深/跟随系统选择器只在它被选中时出现：
                                                未选中时砖脚只留主色样例，避免每块砖都挂一个下拉控件。 */}
                                            {t.builtin ? (
                                                active && (
                                                    <div onClick={(e) => e.stopPropagation()}>
                                                        <Select<BuiltinScheme>
                                                            value={builtinScheme}
                                                            options={[
                                                                { value: 'light', label: '浅色' },
                                                                { value: 'dark', label: '深色' },
                                                                { value: 'system', label: '跟随系统' },
                                                            ]}
                                                            onChange={handleSchemeChange}
                                                        />
                                                    </div>
                                                )
                                            ) : (
                                                <div
                                                    className={`theme-tile-actions${confirmingId === t.id ? ' is-confirming' : ''}`}
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <ThemeDeleteButton
                                                        theme={t}
                                                        open={confirmingId === t.id}
                                                        onOpenChange={(o) => setConfirmingId(o ? t.id : null)}
                                                        onRemove={() => void handleRemove(t)}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )
                        })}
                    </div>

                    {onlyBuiltin && !loading && (
                        <div className="theme-empty">
                            <Icon name="info-circle" size={28} className="theme-empty-icon" />
                            <span className="theme-empty-text">暂无自定义主题</span>
                            <span className="theme-empty-hint">
                                点击「+」创建主题，或将主题文件夹放入主题目录后刷新
                            </span>
                        </div>
                    )}
                    {loading && (
                        <div className="theme-loading">
                            <span className="theme-loading-spinner" />
                            <span>正在扫描主题目录…</span>
                        </div>
                    )}
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">显示</h2>
                </header>
                <div className="settings-group-body">
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">搜索栏显示歌曲状态</span>
                            <span className="settings-item-hint">搜索框空闲时，在标题栏搜索区显示当前播放的歌曲；悬停或输入即恢复搜索框</span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={showSongStatus}
                                onChange={(v) => setSetting('appearance.titlebar.showSongStatus', v)}
                            />
                        </div>
                    </label>
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">控制栏歌词预览</span>
                            <span className="settings-item-hint">在底部控制栏显示当前歌词</span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={showLyricPreview}
                                onChange={(v) => setSetting('appearance.control.showLyricPreview', v)}
                            />
                        </div>
                    </label>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">动效</h2>
                </header>
                <div className="settings-group-body">
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">界面动效</span>
                            <span className="settings-item-hint">关闭后全局禁用过渡与动画</span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={motionEnabled}
                                onChange={(v) => setSetting('appearance.motion.enabled', v)}
                            />
                        </div>
                    </label>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">系统</h2>
                </header>
                <div className="settings-group-body">
                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">窗口背景材质</span>
                            <span className="settings-item-hint">
                                {IS_WINDOWS
                                    ? 'Windows 11 支持 Mica / Tabbed，Acrylic 在 Windows 10 及以上可用'
                                    : '仅 Windows 平台支持，当前系统不可用'}
                            </span>
                        </div>
                        {IS_WINDOWS && (
                            <div className="settings-item-action">
                                <Select
                                    value={backgroundMaterial}
                                    disabled={materialLoading}
                                    options={[
                                        { value: 'none', label: '无' },
                                        { value: 'mica', label: 'Mica' },
                                        { value: 'acrylic', label: 'Acrylic' },
                                        { value: 'tabbed', label: 'Tabbed' },
                                    ]}
                                    onChange={(v) => void handleBackgroundMaterial(v as BackgroundMaterial)}
                                />
                            </div>
                        )}
                    </div>
                </div>
            </section>
        </>
    )
}
