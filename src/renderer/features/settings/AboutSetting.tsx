import type { ReactNode } from 'react'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { useSettingsStore, useUpdateStore } from '@renderer/store'
import { openExternal } from '@renderer/lib/system'
import { useUpdate } from '@renderer/features/update/useUpdate'

const REPO_BASE = `https://github.com/${__APP_REPO_OWNER__}/${__APP_REPO_NAME__}`
const RELEASES_URL = `${REPO_BASE}/releases`
const ISSUES_URL = `${REPO_BASE}/issues`

const mb = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MB`

const speed = (bytesPerSecond: number): string =>
    bytesPerSecond >= 1048576
        ? `${(bytesPerSecond / 1048576).toFixed(1)} MB/s`
        : `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`

function formatDateTime(iso: string): string {
    if (!iso) return '未知'
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '未知'
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 行内外链 */
function ExternalLink({ url, children }: { url: string; children: ReactNode }) {
    return (
        <a
            className="about-inline-link"
            href={url}
            rel="noreferrer"
            onClick={(e) => {
                e.preventDefault()
                void openExternal(url)
            }}
        >
            {children}
        </a>
    )
}

export function AboutSetting() {
    const storedVersion = useSettingsStore((s) => s.settings['application.version'])
    const autoDownload = useSettingsStore((s) => s.settings['update.autoDownload'])
    const showChangelogAfterUpdate = useSettingsStore((s) => s.settings['update.showChangelogAfterUpdate'])
    const setSetting = useSettingsStore((s) => s.setSetting)
    const openChangelog = useUpdateStore((s) => s.openChangelog)
    const changelogLoading = useUpdateStore((s) => s.changelog.loading)

    const { state, progress, check, download, install } = useUpdate()

    const currentVersion = state.currentVersion || storedVersion
    const busy = state.status === 'checking' || state.status === 'downloading'
    /**
     * 「已是最新」只在明确检查过之后才算 —— idle（还没查过）和 error（没查成）都不能认，
     * 否则用户第一次进关于页就会看到「已是最新」+ 一个点不动的按钮。
     */
    const upToDate = state.status === 'not-available'

    /** 只保留「上面四行信息里没有表达出来」的状态，避免重复 */
    const statusText = (): string => {
        switch (state.status) {
            case 'checking':
                return '正在检查更新…'
            case 'available':
                return `发现新版本 v${state.latestVersion ?? ''}`
            case 'downloading':
                return progress
                    ? `正在下载 ${Math.floor(progress.percent)}%（${mb(progress.transferred)} / ${mb(progress.total)} · ${speed(progress.bytesPerSecond)}）`
                    : '正在下载…'
            case 'downloaded':
                return `v${state.latestVersion ?? ''} 已下载完成，重启或退出应用后生效`
            case 'error':
                return `检查失败：${state.error ?? '未知原因'}`
            default:
                return ''
        }
    }

    /** 主操作按钮：每个状态只暴露一个动作，避免越级调用 */
    const primaryButton = () => {
        if (state.status === 'available') {
            return (
                <button type="button" className="settings-btn" onClick={download}>
                    下载更新
                </button>
            )
        }
        if (state.status === 'downloaded') {
            return (
                <button type="button" className="settings-btn" onClick={install}>
                    重启并安装
                </button>
            )
        }

        const label = state.status === 'checking'
            ? '正在检查…'
            : state.status === 'downloading'
              ? '下载中…'
              : state.status === 'error'
                ? '重试'
                : '检查更新'

        return (
            <button type="button" className="settings-btn" onClick={check} disabled={busy || upToDate}>
                {label}
            </button>
        )
    }

    const text = statusText()

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">软件更新</h2>
                </header>
                <div className="settings-group-body">
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">自动下载新版本</span>
                            <span className="settings-item-hint">
                                开启后检查到新版本会在后台静默下载，完成后提示重启；关闭则只提示有新版本
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={autoDownload}
                                onChange={(v) => setSetting('update.autoDownload', v)}
                            />
                        </div>
                    </label>

                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">更新后显示更新日志</span>
                            <span className="settings-item-hint">
                                升级到新版本后首次启动时，弹出本次更新的内容
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={showChangelogAfterUpdate}
                                onChange={(v) => setSetting('update.showChangelogAfterUpdate', v)}
                            />
                        </div>
                    </label>

                    <div className="update-panel">
                        <div className="update-panel-info">
                            <p className="update-info-line">
                                当前版本：{currentVersion ? `v${currentVersion}` : '未知'}
                                {upToDate && <span className="update-info-note">（已是最新版本）</span>}
                            </p>
                            <p className="update-info-line">
                                代码版本：<span className="update-info-mono">{__APP_COMMIT__}</span>
                            </p>
                            <p className="update-info-line">
                                提交日期：<span className="update-info-mono">{formatDateTime(__APP_COMMIT_DATE__)}</span>
                            </p>
                            <p className="update-info-line">
                                最新版本：{state.latestVersion ? `v${state.latestVersion}` : '未检查'}
                            </p>

                            {state.status === 'downloading' && progress && (
                                <div
                                    className="update-progress"
                                    role="progressbar"
                                    aria-label="更新下载进度"
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(progress.percent)}
                                >
                                    <div
                                        className="update-progress-bar"
                                        style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
                                    />
                                </div>
                            )}

                            {text && (
                                <p
                                    className={
                                        state.status === 'error' ? 'update-status is-error' : 'update-status'
                                    }
                                    aria-live="polite"
                                >
                                    {text}
                                </p>
                            )}
                        </div>

                        <div className="update-panel-actions">
                            <button
                                type="button"
                                className="settings-btn"
                                disabled={changelogLoading}
                                onClick={() => void openChangelog(currentVersion || null, { inclusive: true })}
                            >
                                {changelogLoading ? '获取中…' : '查看变更日志'}
                            </button>
                            {primaryButton()}
                        </div>
                    </div>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">关于 LightPlayer</h2>
                </header>
                <div className="settings-group-body">
                    <div className="about-lines">
                        <p className="about-line">
                            本项目已在 GitHub 上开源：
                            <ExternalLink url={REPO_BASE}>{REPO_BASE}</ExternalLink>
                        </p>
                        <p className="about-line">
                            最新版下载地址：<ExternalLink url={RELEASES_URL}>GitHub Release</ExternalLink>
                        </p>
                        <p className="about-line">
                            如有任何问题或意见可到 GitHub 上提交{' '}
                            <ExternalLink url={ISSUES_URL}>Issue</ExternalLink>
                        </p>
                    </div>
                </div>
            </section>
        </>
    )
}
