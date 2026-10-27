import { Icon } from '@renderer/components/Icon'
import { Select, type SelectOption } from '@renderer/components/ui/Select'
import { useSettingsStore } from '@renderer/store'

/**
 * 桌面歌词设置页
 */
export function DesktopLyricSetting() {
    /** 配色方案预设 */
    const COLOR_SCHEMES = [
        { name: '清新绿', played: '#DCE61E', unplayed: '#3CC323' },
        { name: '可爱粉', played: '#DCE61E', unplayed: '#CD46C3' },
        { name: '深邃蓝', played: '#DCE61E', unplayed: '#37AFFF' },
        { name: '高雅灰', played: '#37AFFF', unplayed: '#D7D7D7' },
        { name: '活力黄', played: '#00FFFF', unplayed: '#FFAF00' },
        { name: '渐变紫', played: '#B24BF3', unplayed: '#E0C3FC' },
        { name: '天空蓝', played: '#00BFFF', unplayed: '#E0F7FA' },
        { name: '烈焰红', played: '#FF4444', unplayed: '#FFCDD2' },
        { name: '暖阳橙', played: '#FF9800', unplayed: '#FFF3E0' },
        { name: '经典金', played: '#FFD700', unplayed: '#FFFFFF' },
        { name: '纯净白', played: '#FFFFFF', unplayed: '#9E9E9E' },
    ] as const

    // Select 的取值是字符串，行数是数字语义
    const LINE_COUNT_OPTIONS: SelectOption<'1' | '2'>[] = [
        { value: '1', label: '单行' },
        { value: '2', label: '双行' },
    ]

    const ALIGN_OPTIONS: SelectOption<'center' | 'alternate'>[] = [
        { value: 'alternate', label: '左右分离' },
        { value: 'center', label: '居中' },
    ]

    const SECONDARY_LINE_OPTIONS: SelectOption<'none' | 'translation' | 'roma'>[] = [
        { value: 'none', label: '不显示' },
        { value: 'translation', label: '翻译' },
        { value: 'roma', label: '罗马音' },
    ]

    const MIN_FONT_SIZE = 14
    const MAX_FONT_SIZE = 48
    const FONT_SIZE_STEP = 4

    const palette = useSettingsStore((s) => s.settings['desktopLyric.colorPalette'])
    const font = useSettingsStore((s) => s.settings['desktopLyric.font'])
    const secondaryLine = useSettingsStore((s) => s.settings['desktopLyric.secondaryLine'])
    const lineCount = useSettingsStore((s) => s.settings['desktopLyric.lineCount'])
    const align = useSettingsStore((s) => s.settings['desktopLyric.align'])
    const setSetting = useSettingsStore((s) => s.setSetting)

    const setPalette = (played: string, unplayed: string) =>
        setSetting('desktopLyric.colorPalette', { played, unplayed })

    const setFontSize = (size: number) => setSetting('desktopLyric.font', { ...font, size })

    const clampFontSize = (size: number) =>
        Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)))

    const handleFontSizeInput = (raw: string) => {
        // 清空是输入的中间态，此时保持原值，别把空串夹成最小值
        if (raw.trim() === '') return
        const v = Number(raw)
        if (Number.isNaN(v)) return
        setFontSize(clampFontSize(v))
    }

    // 当前命中的预设；-1 = 自定义（与预设都不相等）
    const activeSchemeIndex = COLOR_SCHEMES.findIndex(
        (s) => s.played === palette.played && s.unplayed === palette.unplayed,
    )

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">配色方案</h2>
                </header>
                <div className="settings-group-body">
                    <div className="desktop-lyric-scheme-grid">
                        {COLOR_SCHEMES.map((s, i) => (
                            <button
                                key={s.name}
                                type="button"
                                className={`desktop-lyric-scheme-item${activeSchemeIndex === i ? ' is-active' : ''}`}
                                title={s.name}
                                onClick={() => setPalette(s.played, s.unplayed)}
                            >
                                <span
                                    className="desktop-lyric-scheme-circle"
                                    style={{ background: `linear-gradient(135deg, ${s.played} 50%, ${s.unplayed} 50%)` }}
                                />
                                <span className="desktop-lyric-scheme-name">{s.name}</span>
                            </button>
                        ))}

                        {/* 自定义：圆里两个三角色块各自可点，分别取已唱 / 未唱色 */}
                        <div
                            className={`desktop-lyric-scheme-item${activeSchemeIndex === -1 ? ' is-active' : ''}`}
                            title="自定义"
                        >
                            <span className="desktop-lyric-scheme-circle desktop-lyric-scheme-circle--custom">
                                <label
                                    className="desktop-lyric-color-half desktop-lyric-color-half--played"
                                    style={{ background: palette.played }}
                                >
                                    <input
                                        type="color"
                                        className="desktop-lyric-color-input"
                                        value={palette.played}
                                        onChange={(e) => setPalette(e.target.value, palette.unplayed)}
                                    />
                                </label>
                                <label
                                    className="desktop-lyric-color-half desktop-lyric-color-half--unplayed"
                                    style={{ background: palette.unplayed }}
                                >
                                    <input
                                        type="color"
                                        className="desktop-lyric-color-input"
                                        value={palette.unplayed}
                                        onChange={(e) => setPalette(palette.played, e.target.value)}
                                    />
                                </label>
                            </span>
                            <span className="desktop-lyric-scheme-name">自定义</span>
                        </div>
                    </div>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">显示</h2>
                </header>
                <div className="settings-group-body">
                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">歌词行数</span>
                            <span className="settings-item-hint">同时显示的歌词行数</span>
                        </div>
                        <div className="settings-item-action">
                            <Select
                                value={lineCount === 1 ? '1' : '2'}
                                options={LINE_COUNT_OPTIONS}
                                onChange={(v) => setSetting('desktopLyric.lineCount', v === '1' ? 1 : 2)}
                            />
                        </div>
                    </div>

                    {/* 对齐方式只对双行有意义 */}
                    {lineCount === 2 && (
                        <div className="settings-item">
                            <div className="settings-item-label">
                                <span className="settings-item-name">对齐方式</span>
                                <span className="settings-item-hint">双行模式下的歌词布局方式</span>
                            </div>
                            <div className="settings-item-action">
                                <Select
                                    value={align}
                                    options={ALIGN_OPTIONS}
                                    onChange={(v) => setSetting('desktopLyric.align', v)}
                                />
                            </div>
                        </div>
                    )}

                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">翻译 / 罗马音</span>
                            <span className="settings-item-hint">在主歌词行下方显示哪一支辅助行（有的话）</span>
                        </div>
                        <div className="settings-item-action">
                            <Select
                                value={secondaryLine}
                                options={SECONDARY_LINE_OPTIONS}
                                onChange={(v) => setSetting('desktopLyric.secondaryLine', v)}
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">字体</h2>
                </header>
                <div className="settings-group-body">
                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">字体</span>
                            <span className="settings-item-hint">歌词显示字体，留空则用系统默认</span>
                        </div>
                        <div className="settings-item-action">
                            <input
                                className="settings-input desktop-lyric-font-input"
                                placeholder="system-ui"
                                value={font.family}
                                onChange={(e) => setSetting('desktopLyric.font', { ...font, family: e.target.value })}
                            />
                        </div>
                    </div>

                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">字体大小</span>
                            <span className="settings-item-hint">{font.size}px</span>
                        </div>
                        <div className="settings-item-action desktop-lyric-font-size">
                            <button
                                type="button"
                                className="settings-btn desktop-lyric-font-btn"
                                title="减小字号"
                                disabled={font.size <= MIN_FONT_SIZE}
                                onClick={() => setFontSize(clampFontSize(font.size - FONT_SIZE_STEP))}
                            >
                                <Icon name="dash" size={12}/>
                            </button>
                            <input
                                className="settings-input desktop-lyric-font-size-input"
                                type="number"
                                min={MIN_FONT_SIZE}
                                max={MAX_FONT_SIZE}
                                step={FONT_SIZE_STEP}
                                value={font.size}
                                onChange={(e) => handleFontSizeInput(e.target.value)}
                            />
                            <button
                                type="button"
                                className="settings-btn desktop-lyric-font-btn"
                                title="增大字号"
                                disabled={font.size >= MAX_FONT_SIZE}
                                onClick={() => setFontSize(clampFontSize(font.size + FONT_SIZE_STEP))}
                            >
                                <Icon name="add" size={12}/>
                            </button>
                        </div>
                    </div>
                </div>
            </section>
        </>
    )
}
