import { useEffect, useState } from 'react'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Icon } from '@renderer/components/Icon'
import { Modal } from '@renderer/components/ui/Modal'
import { usePlugins } from '@renderer/features/plugin/usePlugin'
import { PluginIcon } from '@renderer/features/plugin/PluginIcon'
import {
    togglePlugin,
    removePlugin,
    togglePluginCommand,
    togglePluginProvider,
} from '@renderer/features/plugin/pluginService'
import { pluginDir } from '@renderer/lib/plugin'
import { openDirInExplorer } from '@renderer/lib/file'
import { getPluginDataStats, type PluginDataStats } from '@renderer/lib/db'
import { openExternal } from '@renderer/lib/system'
import { message } from '@renderer/lib/message'
import { isOk } from '@shared/result'

const STATE_META: Record<PluginState, { label: string; tone: string }> = {
    active: { label: '运行中', tone: 'active' },
    inactive: { label: '已停用', tone: 'inactive' },
    installed: { label: '未启用', tone: 'installed' },
    error: { label: '异常', tone: 'error' },
}

function isCommandEnabled(p: PluginInfo, command: string): boolean {
    return !p.config?.disabledCommands?.includes(command)
}

function isProviderEnabled(p: PluginInfo, targetPlugin: string, command: string): boolean {
    const key = `${targetPlugin}:${command}`
    return !p.config?.disabledProviders?.includes(key)
}

/** 从绝对路径取文件夹名 */
function folderName(dirPath: string): string {
    const parts = dirPath.split(/[\\/]/)
    return parts[parts.length - 1] ?? ''
}

/**
 * 卸载影响清单的一条。
 * tone 只表达语义（代价 / 安心 / 中性说明），具体配色归主题层。
 */
interface UninstallImpact {
    tone: 'loss' | 'safe' | 'note'
    text: string
}

const IMPACT_ICON: Record<UninstallImpact['tone'], 'exclamation-circle' | 'check-circle' | 'info-circle'> = {
    loss: 'exclamation-circle',
    safe: 'check-circle',
    note: 'info-circle',
}

/** 把统计数据译成「卸载会发生什么」 */
function getUninstallImpacts(stats: PluginDataStats): UninstallImpact[] {
    const impacts: UninstallImpact[] = [
        { tone: 'loss', text: '插件目录、配置与缓存将一并删除，不可恢复' },
    ]
    const online = stats.songCount - stats.downloadedCount
    if (online > 0) {
        impacts.push({ tone: 'loss', text: `${online} 首歌曲未下载到本地，卸载后无法播放` })
    }
    if (stats.playlistCount > 0) {
        impacts.push({ tone: 'loss', text: `${stats.playlistCount} 个歌单的在线服务将不可用` })
    }
    if (stats.downloadedCount > 0) {
        impacts.push({
            tone: 'safe',
            text: `已下载到本地的 ${stats.downloadedCount} 首歌曲不受影响`,
        })
    }
    if (stats.songCount === 0 && stats.playlistCount === 0) {
        impacts.push({ tone: 'note', text: '该插件未在程序中产生歌曲或歌单数据' })
    }
    return impacts
}

/** 目标行副行的数据摘要；无数据时返回空串 */
function getDataSummary(stats: PluginDataStats): string {
    const parts: string[] = []
    if (stats.songCount > 0) parts.push(`${stats.songCount} 首歌曲`)
    if (stats.playlistCount > 0) parts.push(`${stats.playlistCount} 个歌单`)
    if (stats.likedCount > 0) parts.push(`${stats.likedCount} 首已喜欢`)
    return parts.join(' · ')
}

export function PluginSetting() {
    const plugins = usePlugins()
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [busy, setBusy] = useState(false)

    /**
     * 卸载确认。
     * 关闭时只关 open、目标留着 —— Radix 的关闭动画期间面板仍在渲染，
     * 这时若把目标/统计清空，内容会在退出动画里闪成占位文案。
     */
    const [confirmTarget, setConfirmTarget] = useState<PluginInfo | null>(null)
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [stats, setStats] = useState<PluginDataStats | null>(null)
    const targetId = confirmTarget?.id ?? null

    // 统计该插件在程序中产生的数据量。只在打开 / 换目标时重置为 null（= 统计中）；
    // 关闭时不清，退出动画期间继续显示已就绪的结果。
    useEffect(() => {
        if (!confirmOpen || !targetId) return
        let cancelled = false
        setStats(null)
        void getPluginDataStats(targetId).then((r) => {
            if (!cancelled && r.success) setStats(r.value)
        })
        return () => {
            cancelled = true
        }
    }, [confirmOpen, targetId])

    const toggleExpand = (id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
        })
    }

    /** 打开插件目录 */
    const handleOpenDir = async () => {
        const dir = await pluginDir()
        if (!dir) {
            return
        }
        await openDirInExplorer(dir)
    }

    const handleTogglePlugin = async (p: PluginInfo, enabled: boolean) => {
        await togglePlugin(p.id, enabled)
    }

    const handleToggleCommand = async (p: PluginInfo, command: string, enabled: boolean) => {
        await togglePluginCommand(p.id, command, enabled)
    }

    const handleToggleProvider = async (
        p: PluginInfo,
        targetPlugin: string,
        command: string,
        enabled: boolean,
    ) => {
        await togglePluginProvider(p.id, targetPlugin, command, enabled)
    }

    const openConfirm = (p: PluginInfo) => {
        setConfirmTarget(p)
        setConfirmOpen(true)
    }

    const handleUninstall = async (p: PluginInfo) => {
        setBusy(true)
        const r = await removePlugin(p.id)
        setBusy(false)
        setConfirmOpen(false)
        if (isOk(r)) message.success(`已卸载插件「${p.name}」`)
        else message.error(`卸载插件「${p.name}」失败：${r.error}`)
    }

    const handleOpenHome = async (url?: string) => {
        if (url) await openExternal(url)
    }

    const summary = stats ? getDataSummary(stats) : ''
    const impacts = stats ? getUninstallImpacts(stats) : []

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">插件</h2>
                    <div className="settings-toolbar">
                        <button
                            type="button"
                            className="icon-button center icon-button--sm"
                            title="在文件管理器中打开插件目录"
                            onClick={() => void handleOpenDir()}
                        >
                            <Icon name="folder"/>
                        </button>
                    </div>
                </header>

                <div className="settings-group-body">
                    {plugins.length === 0 ? (
                        <div className="plugin-empty">
                            <Icon name="info-circle" size={28}/>
                            <span className="plugin-empty-text">暂无已安装的插件</span>
                        </div>
                    ) : (
                        <div className="plugin-list">
                            {plugins.map((p) => {
                                const isOpen = expanded.has(p.id)
                                const meta = STATE_META[p.state] ?? STATE_META.installed
                                const folder = folderName(p.dirPath)
                                return (
                                    <div
                                        key={p.id}
                                        className={`plugin-item${isOpen ? ' is-open' : ''}${
                                            p.state === 'error' ? ' is-error' : ''
                                        }`}
                                    >
                                        <div
                                            className="plugin-item-main"
                                            onClick={() => toggleExpand(p.id)}
                                        >
                                            <button
                                                type="button"
                                                className="icon-button center plugin-expand"
                                                title={isOpen ? '收起' : '展开'}
                                                onClick={(e) => {
                                                    e.stopPropagation()
                                                    toggleExpand(p.id)
                                                }}
                                            >
                                                <Icon name="chevron-right"/>
                                            </button>
                                            <PluginIcon
                                                iconUrl={p.iconUrl}
                                                className="plugin-item-icon"
                                            />
                                            <div className="plugin-item-info">
                                                <div className="plugin-item-name-row">
                                                    <span className="plugin-item-name">
                                                        {p.name}
                                                    </span>
                                                    <span className="plugin-item-version">
                                                        v{p.version}
                                                    </span>
                                                    <span
                                                        className={`plugin-badge plugin-badge--${meta.tone}`}
                                                    >
                                                        {meta.label}
                                                    </span>
                                                </div>
                                                {p.description && (
                                                    <span className="plugin-item-desc">
                                                        {p.description}
                                                    </span>
                                                )}
                                            </div>
                                            <div
                                                className="plugin-item-enable"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <Checkbox
                                                    checked={p.enabled}
                                                    ariaLabel={`启用 ${p.name}`}
                                                    onChange={(v) => void handleTogglePlugin(p, v)}
                                                />
                                            </div>
                                        </div>

                                        {p.state === 'error' && p.error && (
                                            <div
                                                className="plugin-error"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <Icon name="exclamation-circle" size={14}/>
                                                <span>{p.error}</span>
                                            </div>
                                        )}

                                        <div className="plugin-detail-wrap">
                                            <div
                                                className="plugin-detail"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <div className="plugin-detail-inner">
                                                    <div className="plugin-meta">
                                                        <span className="plugin-meta-item">
                                                            <span className="plugin-meta-key">
                                                                插件 ID
                                                            </span>
                                                            <span className="plugin-meta-mono">
                                                                {p.id}
                                                            </span>
                                                        </span>
                                                        {folder && (
                                                            <span className="plugin-meta-item">
                                                                <span className="plugin-meta-key">
                                                                    文件夹
                                                                </span>
                                                                <span className="plugin-meta-mono">
                                                                    {folder}
                                                                </span>
                                                            </span>
                                                        )}
                                                        {p.installedAt && (
                                                            <span className="plugin-meta-item">
                                                                <span className="plugin-meta-key">
                                                                    安装时间
                                                                </span>
                                                                {p.installedAt}
                                                            </span>
                                                        )}
                                                        {p.author && (
                                                            <span className="plugin-meta-item">
                                                                <span className="plugin-meta-key">
                                                                    作者
                                                                </span>
                                                                {p.author}
                                                            </span>
                                                        )}
                                                        {p.homePage && (
                                                            <button
                                                                type="button"
                                                                className="plugin-meta-item plugin-meta-link"
                                                                onClick={() =>
                                                                    void handleOpenHome(p.homePage)
                                                                }
                                                            >
                                                                <span className="plugin-meta-key">
                                                                    主页
                                                                </span>
                                                                <span className="plugin-meta-arrow">
                                                                    ↗
                                                                </span>
                                                            </button>
                                                        )}
                                                    </div>

                                                    {p.commands.length > 0 && (
                                                        <div className="plugin-subsection">
                                                            <div className="plugin-subsection-title">
                                                                命令
                                                            </div>
                                                            {p.commands.map((c) => {
                                                                const cmdEnabled = isCommandEnabled(p, c.command)
                                                                return (
                                                                    <div
                                                                        className="plugin-row"
                                                                        key={c.command}
                                                                        onClick={() =>
                                                                            void handleToggleCommand(
                                                                                p,
                                                                                c.command,
                                                                                !cmdEnabled,
                                                                            )
                                                                        }
                                                                    >
                                                                        <div className="plugin-row-label">
                                                                            <span className="plugin-row-name">
                                                                                {c.title ?? c.command}
                                                                            </span>
                                                                            <span className="plugin-row-cmd">
                                                                                {c.command}
                                                                            </span>
                                                                        </div>
                                                                        <span
                                                                            className="plugin-row-toggle"
                                                                            onClick={(e) =>
                                                                                e.stopPropagation()
                                                                            }
                                                                        >
                                                                            <Checkbox
                                                                                checked={cmdEnabled}
                                                                                ariaLabel={`启用 ${c.title ?? c.command}`}
                                                                                onChange={(v) =>
                                                                                    void handleToggleCommand(
                                                                                        p,
                                                                                        c.command,
                                                                                        v,
                                                                                    )
                                                                                }
                                                                            />
                                                                        </span>
                                                                    </div>
                                                                )
                                                            })}
                                                        </div>
                                                    )}

                                                    {p.providers.length > 0 && (
                                                        <div className="plugin-subsection">
                                                            <div className="plugin-subsection-title">
                                                                提供者
                                                            </div>
                                                            {p.providers.map((pr) => {
                                                                const prEnabled = isProviderEnabled(
                                                                    p,
                                                                    pr.targetPlugin,
                                                                    pr.command,
                                                                )
                                                                return (
                                                                    <div
                                                                        className="plugin-row"
                                                                        key={`${pr.targetPlugin}:${pr.command}`}
                                                                        onClick={() =>
                                                                            void handleToggleProvider(
                                                                                p,
                                                                                pr.targetPlugin,
                                                                                pr.command,
                                                                                !prEnabled,
                                                                            )
                                                                        }
                                                                    >
                                                                        <div className="plugin-row-label">
                                                                            <span className="plugin-row-name">
                                                                                {pr.title ??
                                                                                    pr.command}
                                                                            </span>
                                                                            <span className="plugin-row-cmd">
                                                                                {pr.targetPlugin}:
                                                                                {pr.command}
                                                                            </span>
                                                                        </div>
                                                                        <span
                                                                            className="plugin-row-toggle"
                                                                            onClick={(e) =>
                                                                                e.stopPropagation()
                                                                            }
                                                                        >
                                                                            <Checkbox
                                                                                checked={prEnabled}
                                                                                ariaLabel={`启用 ${pr.targetPlugin}:${pr.command}`}
                                                                                onChange={(v) =>
                                                                                    void handleToggleProvider(
                                                                                        p,
                                                                                        pr.targetPlugin,
                                                                                        pr.command,
                                                                                        v,
                                                                                    )
                                                                                }
                                                                            />
                                                                        </span>
                                                                    </div>
                                                                )
                                                            })}
                                                        </div>
                                                    )}

                                                    {p.commands.length === 0 &&
                                                        p.providers.length === 0 && (
                                                            <div className="plugin-detail-empty">
                                                                该插件未声明命令或提供者
                                                            </div>
                                                        )}

                                                    <div className="plugin-detail-actions">
                                                        <button
                                                            type="button"
                                                            className="plugin-del-btn"
                                                            disabled={busy}
                                                            onClick={() => openConfirm(p)}
                                                        >
                                                            <Icon name="trash"/>
                                                            <span>卸载插件</span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    )}

                    <p className="plugin-note">
                        插件是「放在插件目录里的文件夹」，应用启动时扫描一次新增插件后需要
                        <b>重启应用</b>，再在列表里启用它。
                    </p>
                </div>
            </section>

            <Modal
                open={confirmOpen}
                onOpenChange={setConfirmOpen}
                title="卸载插件"
                className="modal--plugin-uninstall"
                escClosable={!busy}
            >
                <div className="plugin-confirm">
                    <div className="plugin-confirm-target">
                        <PluginIcon
                            iconUrl={confirmTarget?.iconUrl}
                            className="plugin-confirm-icon"
                        />
                        <div className="plugin-confirm-target-info">
                            <span className="plugin-confirm-name">{confirmTarget?.name}</span>
                            <span className="plugin-confirm-version">v{confirmTarget?.version}</span>
                            {stats === null ? null : (
                                summary && <span className="plugin-confirm-hint">{summary}</span>
                            )}
                        </div>
                    </div>

                    <div className="plugin-confirm-section">
                        <div className="plugin-confirm-section-title">影响</div>
                        {stats === null ? (
                            confirmOpen && (
                                <div className="plugin-confirm-pending">正在统计插件数据…</div>
                            )
                        ) : (
                            <ul className="plugin-confirm-list">
                                {impacts.map((it) => (
                                    <li
                                        key={it.text}
                                        className={`plugin-confirm-item plugin-confirm-item--${it.tone}`}
                                    >
                                        <Icon name={IMPACT_ICON[it.tone]} size={14}/>
                                        <span>{it.text}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="plugin-confirm-actions">
                        <button
                            type="button"
                            className="plugin-confirm-cancel"
                            onClick={() => setConfirmOpen(false)}
                        >
                            取消
                        </button>
                        <button
                            type="button"
                            className="plugin-confirm-ok"
                            disabled={busy}
                            onClick={() => confirmTarget && void handleUninstall(confirmTarget)}
                        >
                            {busy ? '卸载中…' : '确认卸载'}
                        </button>
                    </div>
                </div>
            </Modal>
        </>
    )
}
