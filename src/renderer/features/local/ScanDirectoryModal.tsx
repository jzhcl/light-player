import { useCallback, useRef, useState } from 'react'
import { isOk } from '@shared/result'
import { formatPlayTime, formatSize } from '@shared/format'
import { Icon } from '@renderer/components/Icon'
import { Modal } from '@renderer/components/ui/Modal'
import { idList, rlog } from '@renderer/lib/log'
import { message } from '@renderer/lib/message'
import { importFeedback } from '@renderer/features/song/songActions'
import { Checkbox } from '@renderer/components/ui/Checkbox'
import { listDir, selectDirectory, getFileInfo } from '@renderer/lib/file'
import { parseAudioMetadata } from '@renderer/lib/audio'
import { createSongFromLocalFile } from '@renderer/features/song/songIngest'
import { deriveLocalSongFields } from '@renderer/lib/fileNameFormat'

interface ScannedSong {
    filePath: string
    name: string
    singer: string
    album: string
    duration: number
    size: number
}

interface ScanDirectoryModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** 导入完成（不论数量）后回调，便于父页刷新列表 */
    onImported?: () => void
}

const AUDIO_EXTENSIONS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma'])
const DIR_CONCURRENCY = 8
const PARSE_CONCURRENCY = 6

/** 给可能挂起的异步调用加超时，避免扫描卡死（如损坏文件 / 无权限目录导致 listDir/parseAudioMetadata 永不 resolve）。 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('超时')), ms)
        p.then(
            (v) => {
                clearTimeout(timer)
                resolve(v)
            },
            (e) => {
                clearTimeout(timer)
                reject(e)
            },
        )
    })
}

export function ScanDirectoryModal({ open, onOpenChange, onImported }: ScanDirectoryModalProps) {
    const [rootDir, setRootDir] = useState('')
    const [filterSmall, setFilterSmall] = useState(true)
    const [filterShort, setFilterShort] = useState(true)
    const [scanned, setScanned] = useState<ScannedSong[]>([])
    const [isScanning, setIsScanning] = useState(false)
    const [phase, setPhase] = useState<'' | 'scanning' | 'parsing'>('')
    const [dirCount, setDirCount] = useState(0)
    const [fileCount, setFileCount] = useState(0)

    const cancelledRef = useRef(false)

    const reset = useCallback(() => {
        cancelledRef.current = false
        setRootDir('')
        setScanned([])
        setIsScanning(false)
        setPhase('')
        setDirCount(0)
        setFileCount(0)
    }, [])

    const handleClose = useCallback(() => {
        cancelledRef.current = true
        onOpenChange(false)
        reset()
    }, [onOpenChange, reset])

    const pickDir = useCallback(async () => {
        const dir = await selectDirectory({ title: '选择要扫描的目录' })
        if (dir) setRootDir(dir)
    }, [])

    const scanDirectoryForAudio = useCallback(
        async (dirPath: string, minSize: number): Promise<string[]> => {
            const results: string[] = []
            let pending = [dirPath]
            while (pending.length > 0 && !cancelledRef.current) {
                const batch = pending.splice(0, DIR_CONCURRENCY)
                const batchResults = await Promise.all(
                    batch.map(async (cur): Promise<{ dirs: string[]; files: string[] }> => {
                        if (cancelledRef.current) return { dirs: [], files: [] }
                        let r
                        try {
                            r = await withTimeout(listDir(cur), 10000)
                        } catch {
                            // 目录无权限 / 读取出错 / 超时：跳过该目录，不阻塞整轮扫描。
                            return { dirs: [], files: [] }
                        }
                        if (!isOk(r)) return { dirs: [], files: [] }
                        const dirs: string[] = []
                        const files: string[] = []
                        for (const e of r.value) {
                            if (e.type === 'directory') {
                                dirs.push(e.path)
                            } else if (e.type === 'file') {
                                const dot = e.name.lastIndexOf('.')
                                if (dot === -1) continue
                                const ext = e.name.slice(dot).toLowerCase()
                                if (!AUDIO_EXTENSIONS.has(ext)) continue
                                if (minSize > 0 && e.size < minSize) continue
                                files.push(e.path)
                            }
                        }
                        return { dirs, files }
                    }),
                )
                for (const { dirs, files } of batchResults) {
                    pending.push(...dirs)
                    results.push(...files)
                }
                setDirCount((d) => d + batch.length)
                setFileCount(results.length)
            }
            return results
        },
        [],
    )

    const parseFileToSong = useCallback(
        async (filePath: string): Promise<ScannedSong | null> => {
            try {
                const metaR = await withTimeout(parseAudioMetadata(filePath), 10000)
                if (!isOk(metaR)) return null
                const meta = metaR.value
                const info = await getFileInfo(filePath)
                const fileName = (info?.name ?? filePath).replace(/\.[^/.]+$/, '')
                // 歌名/歌手/专辑与正式入库共用 deriveLocalSongFields，保证预览与实际一致
                const { name, singer, album } = deriveLocalSongFields(fileName, meta)
                const duration = Math.floor(meta.format.duration || 0)
                const size = info?.size ?? 0
                // 过滤短音频（60s 以下）；但文件 >2MB 却解析为 0 时长属明显解析异常，不按短时长过滤
                const isAbnormalZero = size > 2 * 1024 * 1024 && duration === 0
                if (filterShort && duration < 60 && !isAbnormalZero) return null
                return { filePath, name, singer, album, duration, size }
            } catch {
                // 解析超时 / 出错（损坏文件、无权限等）：跳过该文件，不阻塞整轮扫描。
                return null
            }
        },
        [filterShort],
    )

    // 中止扫描：复位扫描态回配置视图（保留已选目录，便于直接重扫），并置取消标记。
    const abortScan = useCallback(() => {
        cancelledRef.current = true
        setIsScanning(false)
        setPhase('')
        setScanned([])
        setDirCount(0)
        setFileCount(0)
    }, [])

    const executeScan = useCallback(async () => {
        if (!rootDir) {
            return
        }
        cancelledRef.current = false
        setIsScanning(true)
        setScanned([])
        setPhase('scanning')
        try {
            const filePaths = await scanDirectoryForAudio(rootDir, filterSmall ? 100 * 1024 : 0)
            if (cancelledRef.current) {
                abortScan()
                return
            }

            setPhase('parsing')
            const songs: ScannedSong[] = []
            for (let i = 0; i < filePaths.length; i += PARSE_CONCURRENCY) {
                if (cancelledRef.current) break
                const batch = filePaths.slice(i, i + PARSE_CONCURRENCY)
                const batchResults = await Promise.all(batch.map((p) => parseFileToSong(p)))
                for (const s of batchResults) if (s) songs.push(s)
            }

            if (cancelledRef.current) {
                abortScan()
                return
            }
            setScanned(songs)
        } catch (e) {
            abortScan()
        } finally {
            // 兜底：无论正常完成 / 取消 / 异常，都退出扫描态（避免界面卡在「正在扫描」）。
            setIsScanning(false)
            setPhase('')
        }
    }, [rootDir, filterSmall, filterShort, scanDirectoryForAudio, parseFileToSong, abortScan])

    const removeScanned = useCallback((index: number) => {
        setScanned((prev) => prev.filter((_, i) => i !== index))
    }, [])

    const confirmImport = useCallback(async () => {
        if (scanned.length === 0) {
            return
        }
        let imported = 0
        for (const s of scanned) {
            const r = await createSongFromLocalFile(s.filePath)
            if (isOk(r)) imported++
        }
        const failedCount = scanned.length - imported
        rlog.info(
            `[local] 扫描导入 ${scanned.length} 个：成功 ${imported}，失败 ${failedCount}` +
                `\nfiles: ${idList(scanned.map((s) => s.filePath))}`,
        )
        const fb = importFeedback(imported, 0, failedCount)
        message[fb.type](fb.text)
        onOpenChange(false)
        onImported?.()
        reset()
    }, [scanned, onOpenChange, onImported, reset])

    const cancelScan = useCallback(() => {
        abortScan()
    }, [abortScan])

    const footer = isScanning ? (
        <button className="scan-config__btn scan-config__btn--ghost" type="button" onClick={cancelScan}>
            取消扫描
        </button>
    ) : scanned.length === 0 ? (
        <>
            <button className="scan-config__btn scan-config__btn--ghost" type="button" onClick={handleClose}>
                取消
            </button>
            <button
                className="scan-config__btn scan-config__btn--primary"
                type="button"
                onClick={() => void executeScan()}
                disabled={!rootDir}
            >
                开始扫描
            </button>
        </>
    ) : (
        <>
            <button className="scan-config__btn scan-config__btn--ghost" type="button" onClick={handleClose}>
                取消
            </button>
            <button
                className="scan-config__btn scan-config__btn--primary"
                type="button"
                onClick={() => void confirmImport()}
            >
                确认导入 ({scanned.length})
            </button>
        </>
    )

    return (
        <Modal
            open={open}
            onOpenChange={(o) => {
                if (!o) handleClose()
            }}
            title="扫描本地音乐"
            contentStyle={{ width: 700, height: 500 }}
            footer={footer}
        >
            <div className="scan-modal">
                {scanned.length === 0 && !isScanning ? (
                    <div className="scan-config">
                        <div className="scan-config__row">
                            <label className="scan-config__label">扫描目录</label>
                            <div className="scan-config__input-group">
                                <input
                                    className="scan-config__input"
                                    readOnly
                                    placeholder="请选择要扫描的目录"
                                    value={rootDir}
                                    onChange={() => {}}
                                />
                                <button className="scan-config__btn" type="button" onClick={() => void pickDir()}>
                                    选择目录
                                </button>
                            </div>
                        </div>
                        <div className="scan-config__row">
                            <label className="scan-config__option">
                                <Checkbox id="scan-filter-size" checked={filterSmall} onChange={setFilterSmall} />
                                <span>过滤 100KB 以下的文件</span>
                            </label>
                        </div>
                        <div className="scan-config__row">
                            <label className="scan-config__option">
                                <Checkbox id="scan-filter-short" checked={filterShort} onChange={setFilterShort} />
                                <span>过滤 60s 以下的音频</span>
                            </label>
                        </div>
                    </div>
                ) : isScanning ? (
                    <div className="scan-loading">
                        <div className="scan-spinner" />
                        <p>{phase === 'scanning' ? '正在扫描目录…' : '正在解析音频文件…'}</p>
                        <p className="scan-loading__progress">
                            已扫描 {dirCount} 个目录，发现 {fileCount} 个音频文件
                        </p>
                    </div>
                ) : (
                    <div className="scan-results">
                        <div className="scan-results__header">
                            <span className="scan-results__count">找到 {scanned.length} 首歌曲</span>
                        </div>
                        <ScanResultList songs={scanned} onRemove={removeScanned} />
                    </div>
                )}
            </div>
        </Modal>
    )
}

function ScanResultList({ songs, onRemove }: { songs: ScannedSong[]; onRemove: (i: number) => void }) {
    return (
        <div className="scan-results__list">
            {songs.map((s, index) => (
                <div className="scan-result-item" key={s.filePath}>
                    <div className="scan-result-item__info">
                        <div className="scan-result-item__name ellipsis" title={s.name}>
                            {s.name}
                        </div>
                        <div className="scan-result-item__meta">
                            <span>{s.singer}</span>
                            {s.album ? <span> · {s.album}</span> : null}
                            <span> · {formatPlayTime(s.duration)}</span>
                        </div>
                        <div className="scan-result-item__path ellipsis" title={s.filePath}>
                            {s.filePath}
                            {s.size ? ` · ${formatSize(s.size)}` : ''}
                        </div>
                    </div>
                    <button
                        className="scan-result-item__remove"
                        type="button"
                        title="移除"
                        onClick={() => onRemove(index)}
                    >
                        <Icon name="x" size={14} />
                    </button>
                </div>
            ))}
        </div>
    )
}
