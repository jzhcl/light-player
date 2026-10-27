import { useEffect, useRef, useState } from 'react'
import { LP_EVENT } from '@shared/event'
import { isOk } from '@shared/result'
import { useSettingsStore, useUpdateStore } from '@renderer/store'
import { invokeResult } from '@renderer/lib/ipc'
import { message } from '@renderer/lib/message'
import { rlog } from '@renderer/lib/log'
import { Modal } from '@renderer/components/ui/Modal'

/**
 * 自动更新的渲染端宿主。挂在 App 根上，所以用户停在任何页面都能收到提示。
 *
 * 职责三件：
 *   1. 把主进程的两条事件通道写进 updateStore
 *   2. 检查到新版时按 `update.autoDownload` 决定「自动下载」还是「只提示」
 *   3. 下载完成 → Modal 提示重启；刚升级过 → 弹本次更新日志
 *
 * ⚠️ 决策放渲染端而不是主进程：`update.autoDownload` 存在 localStorage，主进程读不到。
 */

const UPGRADE_CHANGELOG_DELAY_MS = 1500

export function UpdateHost() {
    const setState = useUpdateStore((s) => s.setState)
    const setProgress = useUpdateStore((s) => s.setProgress)
    const previousVersion = useUpdateStore((s) => s.previousVersion)
    const latestVersion = useUpdateStore((s) => s.state.latestVersion)
    const changelog = useUpdateStore((s) => s.changelog)
    const closeChangelog = useUpdateStore((s) => s.closeChangelog)

    const [installOpen, setInstallOpen] = useState(false)
    const [installing, setInstalling] = useState(false)

    /** 已处理过的 available 版本，防止同一版本重复触发下载 */
    const handledRef = useRef<string | null>(null)
    /** 升级日志每次启动最多弹一次 */
    const upgradeShownRef = useRef(false)

    useEffect(() => {
        let alive = true

        const handleStatus = (next: UpdateState): void => {
            if (next.status === 'available' && next.latestVersion) {
                if (handledRef.current === next.latestVersion) return
                handledRef.current = next.latestVersion

                // 直接读 store，不用闭包里的值 —— effect 只跑一次，闭包会过期
                const auto = useSettingsStore.getState().settings['update.autoDownload']
                rlog.info(`[update] 发现新版本 v${next.latestVersion}，自动下载：${auto ? '开' : '关'}`)

                if (auto) {
                    void invokeResult<null>('update:download').then((r) => {
                        if (isOk(r)) return
                        rlog.error(`[update] 自动下载失败：${r.error}`)
                        message.error(`自动下载更新失败：${r.error}`, 0)
                    })
                } else {
                    // duration 0 = 不自动关闭：用户可能在别的页面，得能读到这条
                    message.info(`发现新版本 v${next.latestVersion}，可在「设置 - 关于」中下载`, 0)
                }
                return
            }

            if (next.status === 'downloaded' && next.latestVersion) {
                rlog.info(`[update] v${next.latestVersion} 下载完成，提示重启`)
                setInstallOpen(true)
            }
        }

        void invokeResult<UpdateState>('update:getState').then((r) => {
            if (alive && isOk(r)) setState(r.value)
        })

        const offState = window.api.on(LP_EVENT['UPDATE.STATE'], (payload) => {
            const next = payload as UpdateState
            setState(next)
            handleStatus(next)
        })

        const offProgress = window.api.on(LP_EVENT['UPDATE.PROGRESS'], (payload) => {
            setProgress(payload as UpdateProgress)
        })

        return () => {
            alive = false
            offState()
            offProgress()
        }
    }, [setState, setProgress])

    // 刚升级过（main.tsx 写了 previousVersion）→ 按设置弹本次更新内容
    useEffect(() => {
        if (!previousVersion || upgradeShownRef.current) return
        upgradeShownRef.current = true

        const show = useSettingsStore.getState().settings['update.showChangelogAfterUpdate']
        rlog.info(`[update] 检测到刚升级 ${previousVersion} → 当前版本，弹更新日志：${show ? '开' : '关'}`)
        if (!show) return

        // 等首屏动画落定再弹，别和启动抢注意力。
        // silent=true：首启自动弹的那次，拉不到日志就当没这回事，不要弹错误。
        const timer = window.setTimeout(() => {
            void useUpdateStore.getState().openChangelog(previousVersion, { silent: true })
        }, UPGRADE_CHANGELOG_DELAY_MS)

        return () => window.clearTimeout(timer)
    }, [previousVersion])

    const handleInstall = (): void => {
        setInstalling(true)
        void invokeResult<null>('update:install').then((r) => {
            if (isOk(r)) return
            // 成功时应用会直接退出，走不到这里；失败才需要复位按钮
            setInstalling(false)
            message.error(r.error)
        })
    }

    return (
        <>
            <Modal
                open={installOpen}
                onOpenChange={(open) => {
                    if (!installing) setInstallOpen(open)
                }}
                title="更新已就绪"
                className="update-modal"
                contentStyle={{ width: 420 }}
                footer={
                    <>
                        <button
                            type="button"
                            className="update-modal-secondary"
                            disabled={installing}
                            onClick={() => setInstallOpen(false)}
                        >
                            稍后
                        </button>
                        <button
                            type="button"
                            className="update-modal-primary"
                            disabled={installing}
                            onClick={handleInstall}
                        >
                            {installing ? '正在更新…' : '重启并更新'}
                        </button>
                    </>
                }
            >
                <p className="update-modal-text">
                    LightPlayer v{latestVersion ?? ''} 已下载完成，重启后即可使用新版本。
                </p>
                <p className="update-modal-hint">
                    立即重启会关闭当前窗口，安装完成后自动启动；选择「稍后」则会继续使用当前版本，
                    退出应用时自动完成安装。
                </p>
            </Modal>

            <Modal
                open={changelog.open}
                onOpenChange={(open) => {
                    if (!open) closeChangelog()
                }}
                title="更新日志"
                className={`update-modal${changelog.entries ? ' update-modal--changelog' : ''}`}
                contentStyle={{ width: 560 }}
                footer={
                    <button type="button" className="update-modal-primary" onClick={closeChangelog}>
                        知道了
                    </button>
                }
            >
                {changelog.error && <p className="update-changelog-error">{changelog.error}</p>}
                {changelog.entries && (
                    <ChangelogBody
                        entries={changelog.entries}
                        currentVersion={changelog.currentVersion}
                    />
                )}
            </Modal>
        </>
    )
}

const formatDay = (iso: string): string => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * Release 正文是 Markdown。这里只认三种行：标题（#）、列表项（- / *）、普通段落，
 * 内联语法（粗体、`代码`、链接）原样显示 —— 为了一个日志弹窗引一个 markdown
 * 渲染器不划算，而 `###` 这种符号直接暴露给用户又太糙。
 */
function renderNotes(md: string) {
    const text = md.trim()
    if (!text) return <p className="update-changelog-empty">这个版本没有填写更新说明。</p>

    return text.split(/\r?\n/).map((line, i) => {
        const t = line.trim()
        if (!t) return <div key={i} className="update-changelog-gap" />
        if (/^#{1,6}\s/.test(t)) {
            return (
                <p key={i} className="update-changelog-heading">
                    {t.replace(/^#{1,6}\s*/, '')}
                </p>
            )
        }
        if (/^[-*]\s/.test(t)) {
            return (
                <p key={i} className="update-changelog-item">
                    {t.replace(/^[-*]\s*/, '')}
                </p>
            )
        }
        return (
            <p key={i} className="update-changelog-line">
                {t}
            </p>
        )
    })
}

function ChangelogBody({
    entries,
    currentVersion,
}: {
    entries: ChangelogEntry[]
    /** 列表里哪一版是当前运行的版本；手动「查看变更日志」时才有值 */
    currentVersion: string | null
}) {
    if (entries.length === 0) {
        return <p className="update-changelog-empty">没有可显示的更新日志。</p>
    }

    return (
        <div className="update-changelog">
            {entries.map((e) => (
                <section key={e.version} className="update-changelog-entry">
                    <header className="update-changelog-entry-head">
                        <span className="update-changelog-version">v{e.version}</span>
                        {currentVersion === e.version && (
                            <span className="update-changelog-current">当前版本</span>
                        )}
                        <span className="update-changelog-date">{formatDay(e.date)}</span>
                    </header>
                    {renderNotes(e.notes)}
                </section>
            ))}
        </div>
    )
}
