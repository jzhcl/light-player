import { useEffect, useState } from 'react'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Select, type SelectOption } from '@renderer/components/ui/Select'
import { useSettingsStore } from '@renderer/store'
import { invoke, invokeResult } from '@renderer/lib/ipc'
import { QUALITY_OPTIONS } from '@renderer/lib/constants'
import { isOk } from '@shared/result'
import { qualityLabel } from '@shared/format'
import { applyMediaKeys } from '@renderer/features/hotkeys/hotkeys'
import { rlog } from '@renderer/lib/log'

/** 优先播放音质的可选项，按音质由低到高（顺序由 QUALITY_OPTIONS 统一给出）。 */
const PLAY_QUALITY_OPTIONS: SelectOption<Quality>[] = QUALITY_OPTIONS.map((q) => ({ value: q, label: qualityLabel(q) }))

// 常规设置页。
//  - window.closeToTray：主进程 MainSetting，被窗口关闭逻辑消费（最小化到托盘）。
//  - playlist.useSongCoverAsFallback：被歌单详情页消费（自动封面写库；取消设置不撤回已采纳的封面）。
//  - playlist.showPluginTag / showQualityTag：被 SongList 行内件消费（来源 / 音质标签的显隐，
//    见 features/song/row/parts/）。
//  - player.preferredQuality：被 songLinkService 消费（所有歌曲共用的首选播放音质）。
//  - player.autoSkipOnError：被 features/player/autoSkip.ts 消费（播放失败自动切下一首）。
//  - hotkey.mediaKeys.enable：由主进程 globalShortcut 注册（键盘媒体键）。
export function GeneralSetting() {
    const useSongCoverAsFallback = useSettingsStore((s) => s.settings['playlist.useSongCoverAsFallback'])
    const showPluginTag = useSettingsStore((s) => s.settings['playlist.showPluginTag'])
    const showQualityTag = useSettingsStore((s) => s.settings['playlist.showQualityTag'])
    const preferredQuality = useSettingsStore((s) => s.settings['player.preferredQuality'])
    const autoSkipOnError = useSettingsStore((s) => s.settings['player.autoSkipOnError'])
    const mediaKeys = useSettingsStore((s) => s.settings['hotkey.mediaKeys.enable'])
    const setSetting = useSettingsStore((s) => s.setSetting)

    // window.closeToTray 是主进程设置，需经 IPC 读写。
    const [closeToTray, setCloseToTray] = useState(false)
    const [loading, setLoading] = useState(true)

    useEffect(() => {
        void (async () => {
            const r = await invokeResult<boolean>('settings:get', 'window.closeToTray')
            if (isOk(r)) setCloseToTray(r.value)
            setLoading(false)
        })()
    }, [])

    const handleCloseToTray = async (v: boolean) => {
        setCloseToTray(v)
        const r = await invokeResult<true>('settings:set', 'window.closeToTray', v)
        if (!isOk(r)) setCloseToTray(!v) // 写回失败则回滚 UI
    }

    // 多媒体键注册失败（典型：键被其他应用占用）时的内联提示。
    const [mediaKeysError, setMediaKeysError] = useState('')

    // 挂载即核对一次「设置开着、但实际没注册上」的静默不一致。
    useEffect(() => {
        void (async () => {
            if (!useSettingsStore.getState().settings['hotkey.mediaKeys.enable']) return
            const registered = await invoke<boolean>('hotkey:isMediaKeysRegistered')
            if (!registered) setMediaKeysError('未能注册多媒体键，可能已被其他应用占用')
        })()
    }, [])

    const handleMediaKeys = async (v: boolean) => {
        setSetting('hotkey.mediaKeys.enable', v)
        const r = await applyMediaKeys(v)
        if (!isOk(r)) {
            setSetting('hotkey.mediaKeys.enable', !v) // 注册失败则回滚，避免设置与实际不符
            setMediaKeysError(r.error)
            return
        }
        setMediaKeysError('')
    }

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">常规</h2>
                </header>
                <div className="settings-group-body">
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">最小化到托盘</span>
                            <span className="settings-item-hint">关闭后仍在后台运行，点击托盘图标可恢复</span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={closeToTray}
                                disabled={loading}
                                onChange={handleCloseToTray}
                            />
                        </div>
                    </label>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">歌单</h2>
                </header>
                <div className="settings-group-body">
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">歌单封面为空时使用歌曲封面</span>
                            <span className="settings-item-hint">
                                当歌单无封面时，自动使用并保存歌单内第一首有效封面
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={useSongCoverAsFallback}
                                onChange={(v) => setSetting('playlist.useSongCoverAsFallback', v)}
                            />
                        </div>
                    </label>

                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">显示来源标签</span>
                            <span className="settings-item-hint">
                                在歌曲列表右侧显示这首歌的插件来源，本机导入的显示「本地」
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={showPluginTag}
                                onChange={(v) => setSetting('playlist.showPluginTag', v)}
                            />
                        </div>
                    </label>

                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">显示音质标签</span>
                            <span className="settings-item-hint">
                                在歌曲列表右侧显示这首歌支持的最高音质；只有标准音质的歌曲不显示
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={showQualityTag}
                                onChange={(v) => setSetting('playlist.showQualityTag', v)}
                            />
                        </div>
                    </label>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">播放</h2>
                </header>
                <div className="settings-group-body">
                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">优先播放音质</span>
                            <span className="settings-item-hint">
                                歌曲没有这一档时自动取最接近的一档，在线取不到链接时会改播本地已下载的文件
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Select
                                value={preferredQuality}
                                options={PLAY_QUALITY_OPTIONS}
                                onChange={(v) => {
                                    setSetting('player.preferredQuality', v)
                                    rlog.info(`[setting] 首选音质 ${preferredQuality} → ${v}`)
                                }}
                            />
                        </div>
                    </div>

                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">播放失败时自动切换下一首</span>
                            <span className="settings-item-hint">
                                歌曲无法播放（链接失效、文件丢失等）时自动跳过；连续多首失败则停止
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={autoSkipOnError}
                                onChange={(v) => {
                                    setSetting('player.autoSkipOnError', v)
                                    rlog.info(
                                        `[setting] 播放失败自动切换下一首 ${autoSkipOnError ? '开' : '关'} → ${v ? '开' : '关'}`,
                                    )
                                }}
                            />
                        </div>
                    </label>

                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">响应多媒体键</span>
                            <span className="settings-item-hint">
                                响应键盘上的播放 / 暂停、上一首、下一首键，全局生效
                            </span>
                            {mediaKeysError && (
                                <span className="settings-item-error settings-item-error--label">
                                    {mediaKeysError}
                                </span>
                            )}
                        </div>
                        <div className="settings-item-action">
                            <Checkbox checked={mediaKeys} onChange={handleMediaKeys} />
                        </div>
                    </label>
                </div>
            </section>
        </>
    )
}
