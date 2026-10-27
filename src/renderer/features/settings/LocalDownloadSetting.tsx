import { useCallback, useEffect, useState } from 'react'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { Select } from '@renderer/components/ui/Select'
import { useSettingsStore } from '@renderer/store'
import { deleteFile, ensureDir, listDir, openDirInExplorer, selectDirectory } from '@renderer/lib/file'
import { invalidatePicCache } from '@renderer/features/song/songPicCache'
import { clearUnusedPlaylistPics } from '@renderer/features/playlist/playlistPic'
import { FILE_NAME_FORMATS, renderFileName, type FileNameFormat } from '@renderer/lib/fileNameFormat'
import { CHECK_INTERVALS, type LocalFileCheckInterval } from '@renderer/lib/localFileCheck'
import { isOk } from '@shared/result'
import { formatSize } from '@shared/format'
import { join } from '@shared/utils'
import { message } from '@renderer/lib/message'
import { rlog } from '@renderer/lib/log'

// 本地与下载设置页

/** 本地文件检查间隔的展示名 */
const INTERVAL_LABELS: Record<LocalFileCheckInterval, string> = {
    '6h': '6 小时',
    '1d': '1 天',
    '3d': '3 天',
    never: '从不扫描',
}

/** 缓存分类：登记表里的一级子目录即一个分类。 */
interface CacheCategory {
    /** 子目录名，同时作为 key 与删除目标 */
    id: string
    label: string
    size: number
    selected: boolean
}

/**
 * 缓存分类登记表：目录名 → 显示名。
 *
 * ⚠️ 分类靠这张表认定，不是「目录存在即分类」 —— 判据是「我认识这目录吗」。
 * 原因：`cacheDir`（`<userData>/cache`）里除了我们自己的缓存，还住着 Chromium 的
 * 网络磁盘缓存（`Cache_Data` / `No_Vary_Search`，Electron 默认把 session 缓存放在
 * `<userData>/Cache`，Windows 大小写不敏感正好撞上）。若按目录自动发现，这些
 * 不该由用户碰的目录会混进「清除缓存」列表、还会把体量算进缓存总大小。
 *
 * 新增缓存分类（如音频 / 歌词缓存）→ 在这里加一行即可，UI 自动出现对应项。
 * 但清理策略要单独接（见 `handleClearCache`）：并非每个分类都能「全删」。
 */
const CACHE_CATEGORIES: Record<string, string> = {
    SongPic: '歌曲图片',
    PlaylistPic: '歌单图片',
}

/**
 * 文件名格式的展示名
 */
const FORMAT_LABELS: Record<FileNameFormat, string> = {
    'singer_album-name': '歌手_专辑 - 歌名',
    'name-singer_album': '歌名 - 歌手_专辑',
    'singer-name(album)': '歌手 - 歌名（专辑）',
    'name-singer(album)': '歌名 - 歌手（专辑）',
}

/**
 * 效果预览的示例字段
 */
const FORMAT_PREVIEW_SAMPLE = {
    name: '晴天',
    singer: '周杰伦',
    album: '叶惠美',
    quality: 'H',
    ext: 'mp3',
} as const

/** 扫描某分类（一级子目录）下所有文件的总字节数。 */
async function scanDirSize(dir: string): Promise<number> {
    const r = await listDir(dir)
    if (!isOk(r)) return 0
    return r.value.filter((f) => f.type === 'file').reduce((sum, f) => sum + f.size, 0)
}

export function LocalDownloadSetting() {
    const downloadDir = useSettingsStore((s) => s.settings['path.downloadDir'])
    const cacheDir = useSettingsStore((s) => s.settings['path.cacheDir'])
    const preferHigher = useSettingsStore((s) => s.settings['download.preferHigherQuality'])
    const fileNameFormat = useSettingsStore((s) => s.settings['download.fileNameFormat'])
    const checkInterval = useSettingsStore((s) => s.settings['localFile.checkInterval'])
    const setSetting = useSettingsStore((s) => s.setSetting)

    // 当前格式的「效果预览」
    const formatPreview = renderFileName(fileNameFormat, FORMAT_PREVIEW_SAMPLE)

    const [categories, setCategories] = useState<CacheCategory[]>([])
    const [scanning, setScanning] = useState(false)
    const [clearing, setClearing] = useState(false)

    const scanCache = useCallback(async () => {
        if (!cacheDir) {
            setCategories([])
            return
        }
        setScanning(true)
        const entriesR = await listDir(cacheDir)
        if (!isOk(entriesR)) {
            // 目录不存在（首启已 ensureDir，正常不会走到）→ 空分类
            setCategories([])
            setScanning(false)
            return
        }
        // 只认登记表里的分类
        const known = entriesR.value.filter((e) => e.type === 'directory' && e.name in CACHE_CATEGORIES)
        const next = await Promise.all(
            known.map(async (d) => ({
                id: d.name,
                label: CACHE_CATEGORIES[d.name],
                size: await scanDirSize(d.path),
                selected: true,
            })),
        )
        setCategories(next)
        setScanning(false)
    }, [cacheDir])

    useEffect(() => {
        void scanCache()
    }, [scanCache])

    const handleSelectDownloadDir = async () => {
        const dir = await selectDirectory({ title: '选择下载目录', defaultPath: downloadDir || undefined })
        if (!dir) return
        const prev = downloadDir
        setSetting('path.downloadDir', dir)
        rlog.info(`[setting] 下载目录 ${prev || '(未设置)'} → ${dir}`)
        // 目标目录可能不存在，先确保存在
        const ensured = await ensureDir(dir)
        if (!isOk(ensured)) {
            rlog.error(`[setting] 下载目录创建失败：${dir} → ${ensured.error}`)
            message.error(`下载目录已切换，但创建目录失败：${ensured.error}`)
        }
    }

    const toggleCategory = (id: string) => {
        setCategories((prev) => prev.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)))
    }

    const hasSelected = categories.some((c) => c.selected)
    const totalSize = categories.reduce((sum, c) => sum + c.size, 0)

    const handleClearCache = async () => {
        if (clearing || !cacheDir || !hasSelected) return
        setClearing(true)
        const picked = categories.filter((x) => x.selected)
        let deleted = 0
        let failed = 0
        try {
            for (const c of picked) {
                // 歌单图片：只清「没被任何歌单引用」的那些（换封面换下来的旧图）。
                if (c.id === 'PlaylistPic') {
                    const r = await clearUnusedPlaylistPics()
                    deleted += r.deleted
                    failed += r.failed
                    continue
                }
                const r = await listDir(join(cacheDir, c.id))
                if (!isOk(r)) continue
                for (const f of r.value.filter((x) => x.type === 'file')) {
                    const del = await deleteFile(f.path)
                    if (isOk(del)) deleted++
                    else failed++
                }
            }
            // 歌曲图片缓存被清 → 触发重建
            if (picked.some((c) => c.id === 'SongPic')) {
                void invalidatePicCache()
            }
            await scanCache()
        } finally {
            setClearing(false)
        }

        // 破坏性操作必须结算：清了多少、几个没清掉。否则用户只能从「体积小了一点」去猜结果
        const scope = picked.map((c) => c.id).join('、')
        if (failed > 0) rlog.warn(`[cache] 清除缓存 ${scope}：删除 ${deleted} 个，失败 ${failed} 个`)
        else rlog.info(`[cache] 清除缓存 ${scope}：删除 ${deleted} 个`)

        if (deleted === 0 && failed === 0) message.info('没有可清除的缓存')
        else if (failed === 0) message.success(`已清除 ${deleted} 个缓存文件`)
        else if (deleted === 0) message.error(`清除缓存失败：${failed} 个文件未能删除`)
        else message.warn(`已清除 ${deleted} 个缓存文件，${failed} 个未能删除`)
    }

    return (
        <>
            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">本地与下载</h2>
                </header>
                <div className="settings-group-body">
                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">下载目录</span>
                            <span className="settings-item-hint">歌曲文件将保存到此目录</span>
                        </div>
                        <div className="settings-item-action download-path-action">
                            <span className="download-path" title={downloadDir}>
                                {downloadDir || '未设置'}
                            </span>
                            <button
                                type="button"
                                className="settings-btn"
                                onClick={() => void handleSelectDownloadDir()}
                            >
                                浏览
                            </button>
                            <button
                                type="button"
                                className="settings-btn"
                                disabled={!downloadDir}
                                onClick={() => void openDirInExplorer(downloadDir)}
                            >
                                打开
                            </button>
                        </div>
                    </div>

                    {/* 整行可点 */}
                    <label className="settings-item settings-item--toggle">
                        <div className="settings-item-label">
                            <span className="settings-item-name">优先下载较高音质</span>
                            <span className="settings-item-hint">
                                勾选后按歌曲可用的最高音质下载，否则固定标准音质；仅对未指定音质的下载生效
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Checkbox
                                checked={preferHigher}
                                onChange={(v) => {
                                    setSetting('download.preferHigherQuality', v)
                                    rlog.info(
                                        `[setting] 下载优先高音质 ${preferHigher ? '开' : '关'} → ${v ? '开' : '关'}`,
                                    )
                                }}
                            />
                        </div>
                    </label>

                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">文件名格式</span>
                            <span className="settings-item-hint">
                                <span className="download-format-preview">示例：{formatPreview}</span>
                                下载时按此命名（没有专辑时省略专辑段）；扫描本地文件时也按此解析歌名 / 歌手 / 专辑，
                                但只在元数据缺失时才回退文件名。
                                非标准音质会自动附加后缀（_H / _S / _R / _M），解析时自动剥离
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Select<FileNameFormat>
                                value={fileNameFormat}
                                options={FILE_NAME_FORMATS.map((value) => ({
                                    value,
                                    label: FORMAT_LABELS[value],
                                }))}
                                onChange={(v) => setSetting('download.fileNameFormat', v)}
                                className="download-format-select"
                                contentClassName="select--settings"
                                title="文件名格式"
                            />
                        </div>
                    </div>

                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">本地文件检查</span>
                            <span className="settings-item-hint">
                                启动时检查资料库里的本地文件是否存在，不在的行会标灰。距上次检查不足所选时长则跳过全量、
                                只复查已标记的文件；选「从不扫描」则不做启动扫描，但仍沿用上次结果、
                                播放时发现的缺失也照常标灰（文件是否存在最终由播放那一刻判定）。改动需重启后生效。
                            </span>
                        </div>
                        <div className="settings-item-action">
                            <Select<LocalFileCheckInterval>
                                value={checkInterval}
                                options={CHECK_INTERVALS.map((value) => ({ value, label: INTERVAL_LABELS[value] }))}
                                onChange={(v) => {
                                    setSetting('localFile.checkInterval', v)
                                    // 档位只影响「启动时要不要全量扫描」，不是提示层的开关 —— 日志里点明
                                    rlog.info(
                                        `[setting] 本地文件检查间隔 ${checkInterval} → ${v}${v === 'never' ? '（不再主动扫描，沿用上次结果）' : ''}`,
                                    )
                                }}
                                className="download-interval-select"
                                contentClassName="select--settings"
                                title="本地文件检查"
                            />
                        </div>
                    </div>
                </div>
            </section>

            <section className="settings-group">
                <header className="settings-group-header">
                    <h2 className="settings-group-title">缓存</h2>
                    {!scanning && categories.length > 0 && (
                        <span className="settings-group-header-action download-cache-total">
                            {formatSize(totalSize)}
                        </span>
                    )}
                </header>
                <div className="settings-group-body">
                    <div className="settings-item">
                        <div className="settings-item-label">
                            <span className="settings-item-name">缓存目录</span>
                            <span className="settings-item-hint">歌曲封面等缓存文件的存放位置（不可修改）</span>
                        </div>
                        <div className="settings-item-action download-path-action">
                            <span className="download-path" title={cacheDir}>
                                {cacheDir || '未设置'}
                            </span>
                            <button
                                type="button"
                                className="settings-btn"
                                disabled={!cacheDir}
                                onClick={() => void openDirInExplorer(cacheDir)}
                            >
                                打开
                            </button>
                        </div>
                    </div>

                    <div className="settings-item settings-item--clear-cache">
                        <div className="settings-item-label">
                            <span className="settings-item-name">清除缓存</span>
                            <span className="settings-item-hint">
                                {scanning
                                    ? '正在扫描缓存…'
                                    : categories.length === 0
                                      ? '暂无缓存数据'
                                      : '勾选要清除的缓存类别，清除后封面会在后台自动重建'}
                            </span>
                            {categories.length > 0 && (
                                <div className="download-cache-categories">
                                    {categories.map((c) => (
                                        <label key={c.id} className="download-cache-category">
                                            <Checkbox
                                                checked={c.selected}
                                                disabled={clearing}
                                                onChange={() => toggleCategory(c.id)}
                                            />
                                            <span className="download-cache-category-label">{c.label}</span>
                                            <span className="download-cache-category-size">
                                                {formatSize(c.size)}
                                            </span>
                                        </label>
                                    ))}
                                </div>
                            )}
                        </div>
                        <div className="settings-item-action">
                            <button
                                type="button"
                                className="settings-btn settings-btn--danger"
                                disabled={clearing || !cacheDir || !hasSelected}
                                onClick={() => void handleClearCache()}
                            >
                                {clearing ? '清除中…' : '清除缓存'}
                            </button>
                        </div>
                    </div>
                </div>
            </section>
        </>
    )
}
