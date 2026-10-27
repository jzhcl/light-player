import {
    addSongToPlaylist,
    createSong,
    dbFind,
    deleteDownloadRecordsBySongId,
    deletePlaylistSongsBySongId,
    deleteSong as dbDeleteSong,
    deleteSongLyric,
    deleteSongPlayedStats,
    getPlaylistIdsBySongId,
    getSongById,
    getSongPlayedStatsBySongId,
    getUnfinishedDownloadRecordBySongId,
    removeSongFromPlaylist,
    updateSong as dbUpdateSong,
} from '@renderer/lib/db'
import { formatDate, formatQuality, formatSize } from '@shared/format'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { useSettingsStore, usePlayerStore } from '@renderer/store'
import { fail, isOk, ok } from '@shared/result'
import { LIKED_PLAYLIST_ID } from '@renderer/lib/constants'
import { clone, generateId, join } from '@shared/utils'
import { pinyin } from 'pinyin-pro'
import { getFileInfo } from '@renderer/lib/file'
import { cacheSongPicture, parseAudioMetadata, parseDurationWithAudio } from '@renderer/lib/audio'
import { downloadImage, imageExtFromUrl } from '@renderer/lib/download'
import { deriveLocalSongFields } from '@renderer/lib/fileNameFormat'


/** 更新歌曲元数据：写 DB 后 emit SONG.UPDATED */
export async function updateSong(songId: string, patch: Partial<LP.Song>): Promise<Result<boolean>> {
    const r = await dbUpdateSong(songId, patch)
    if (!isOk(r)) return r
    eventBus.emit(LP_EVENT['SONG.UPDATED'], { id: songId, patch })
    return r
}

/** 标记喜欢：写 isLiked + 加入“我喜欢”歌单，emit SONG.LIKED */
export async function markSongLike(songId: string): Promise<Result<boolean>> {
    const r = await dbUpdateSong(songId, { isLiked: true })
    if (!isOk(r)) return r
    const add = await addSongToPlaylist(LIKED_PLAYLIST_ID, songId, 0)
    if (!isOk(add)) return add
    eventBus.emit(LP_EVENT['SONG.LIKED'], { id: songId })
    return r
}

/** 取消喜欢：写 isLiked=false + 移出“我喜欢”歌单，emit SONG.UNLIKED。 */
export async function unmarkSongLike(songId: string): Promise<Result<boolean>> {
    const r = await dbUpdateSong(songId, { isLiked: false })
    if (!isOk(r)) return r
    const del = await removeSongFromPlaylist(LIKED_PLAYLIST_ID, songId)
    if (!isOk(del)) return del
    eventBus.emit(LP_EVENT['SONG.UNLIKED'], { id: songId })
    void cleanupSongIfUnreachable(songId)
    return r
}

/**
 * 判断歌曲是否仍可被用户访问：
 *  - 本地歌曲 / 已下载到本地的歌曲（"本地与下载"页可访问）
 *  - 存在未完成、进行中的下载记录（"本地与下载"页可访问）
 *  - 仍被任意歌单引用
 *  - 仍存在播放记录（"最近播放"页可访问）
 * 满足任一即“可达”，不可回收。查询失败一律按「查不到」处理。
 */
async function isSongReachable(song: LP.Song): Promise<boolean> {
    // 1. 本地歌曲 或 已下载到本地的歌曲
    if (song.pluginId === 'local') return true
    if (song.downloadQualities?.some(q => q.path)) return true

    // 2. 存在未完成、进行中的下载记录
    const dr = await getUnfinishedDownloadRecordBySongId(song.id)
    if (isOk(dr) && dr.value) return true

    // 3. 仍被任意歌单引用
    const playlistIds = await getPlaylistIdsBySongId(song.id)
    if (isOk(playlistIds) && playlistIds.value.length > 0) return true

    // 4. 仍存在播放记录
    const stats = await getSongPlayedStatsBySongId(song.id)
    return isOk(stats) && Boolean(stats.value)
}

/**
 * 删除歌曲及其全部附属数据：
 * 歌单引用 → 播放记录 → 下载记录 → 歌词 → 重置当前播放 → 删除歌曲 → 触发 SONG.DELETED。
 */
async function removeSong(songId: string) {
    // 1. 清理可能存在的歌单引用
    await deletePlaylistSongsBySongId(songId)
    // 2. 清理可能存在的播放记录
    await deleteSongPlayedStats(songId)
    // 3. 清理可能存在的下载记录
    await deleteDownloadRecordsBySongId(songId)
    // 4. 删除歌词
    await deleteSongLyric(songId)
    // 5. 若正播放该曲，重置播放态
    const player = usePlayerStore.getState()
    if (player.currentSong?.id === songId) player.resetCurrentSong()
    // 6. 删除歌曲记录
    await dbDeleteSong(songId)
    // 7. 触发事件
    eventBus.emit(LP_EVENT['SONG.DELETED'], songId)
}

/**
 * 删除歌曲
 * @returns 是否执行了删除（歌曲不存在则返回 false）
 */
export async function deleteSong(songId: string): Promise<boolean> {
    if (!songId) return false
    const song = await getSongById(songId)
    if (!isOk(song) || !song.value) return false
    await removeSong(songId)
    return true
}

/**
 * 若歌曲已无法被用户访问，则彻底删除；仍可达则跳过。
 * 不可达条件：非本地 / 已下载歌曲、无未完成下载记录、不被任何歌单引用、无播放记录。
 * @returns 是否执行了删除
 */
export async function cleanupSongIfUnreachable(songId: string): Promise<boolean> {
    if (!songId) return false
    const song = await getSongById(songId)
    if (!isOk(song) || !song.value) return false
    if (await isSongReachable(song.value)) return false
    await removeSong(songId)
    return true
}


/**
 * 把插件歌曲数据映射为 LP.Song 的可更新字段，并补全名称/歌手/专辑拼音。
 * 仅映射插件侧存在的字段（undefined 跳过），创建与更新共用。
 */
function buildSongPatch(pluginSong: Partial<LP.Plugin.Song>): Partial<LP.Song> {
    const patch: Partial<LP.Song> = {}
    if (pluginSong.name !== undefined) {
        patch.name = pluginSong.name
        patch.namePinyin = pinyin(pluginSong.name, { toneType: 'none' })
    }
    if (pluginSong.album !== undefined) {
        patch.album = pluginSong.album?.name
        patch.albumPinyin = pluginSong.album?.name
            ? pinyin(pluginSong.album.name, { toneType: 'none' })
            : undefined
    }
    if (pluginSong.singer !== undefined) {
        patch.singer = pluginSong.singer.map((s) => s.name).join(' & ')
        patch.singerPinyin = pluginSong.singer
            .map((s) => pinyin(s.name, { toneType: 'none' }))
            .join(' & ')
    }
    if (pluginSong.duration !== undefined) patch.duration = pluginSong.duration
    if (pluginSong.supportQualities !== undefined) {
        patch.supportQualities = pluginSong.supportQualities.map((q) => ({
            type: q.type,
            size: formatSize(q.size || 0),
        }))
    }
    if (pluginSong.pluginId !== undefined) patch.pluginId = pluginSong.pluginId
    return patch
}

/**
 * 解析插件歌曲封面：下载网络图片到缓存目录 SongPic/，返回 { url, path }。
 * 下载失败则 url 保留、path 留空
 */
async function resolvePluginSongPic(
    picUrl?: string,
): Promise<{ url: string; path: string } | undefined> {
    if (!picUrl) return undefined
    const cacheDir = useSettingsStore.getState().settings['path.cacheDir']
    if (!cacheDir) return { url: picUrl, path: '' }
    const savePath = join(cacheDir, 'SongPic', `${generateId('pic')}.${imageExtFromUrl(picUrl)}`)
    const r = await downloadImage(picUrl, savePath)
    const path = isOk(r) && r.value ? savePath : ''
    return { url: picUrl, path }
}

/**
 * 是否需要重新解析封面：
 * URL 变了、或上次没下下来（path 为空）→ 需要重新下载；
 * URL 未变且本地缓存文件仍在 → 复用现有 pic，避免每次落库都重复下载。
 */
function shouldRefreshPic(picUrl: string | undefined, current?: LP.Song['pic']): boolean {
    return !!picUrl && (picUrl !== current?.url || !current?.path)
}

/**
 * 从插件返回的歌曲数据创建 LP.Song 并入库
 */
export async function createSongFromPlugin(
    pluginSong: LP.Plugin.Song,
): Promise<Result<LP.Song>> {
    // 插件返回的歌曲按约定不带 pluginId，须由宿主（聚合处）注入；
    // 缺失时直接失败，避免把 NULL 透到 DB 触发 NOT NULL 约束崩溃。
    if (!pluginSong.pluginId) return fail('歌曲缺少来源插件标识（pluginId）')
    if (!pluginSong.id) return fail('歌曲缺少插件侧 ID')

    const existing = await dbFind('songs', {
        pluginId: pluginSong.pluginId,
        pluginSongId: pluginSong.id,
    })
    if (!isOk(existing)) return fail(existing.error)

    if (existing.value) {
        const songId = existing.value.id as string
        const currentR = await getSongById(songId)
        if (!isOk(currentR)) return fail(currentR.error)
        if (!currentR.value) return fail('更新前未找到歌曲')
        const current = currentR.value

        // meta 是插件原始数据的快照，列字段刷新时必须一并重写快照，
        // 否则 songLinkService 等消费 meta 的能力会一直读到首次落库时的旧数据。
        const patch: Partial<LP.Song> = {
            ...buildSongPatch(pluginSong),
            meta: clone(pluginSong),
        }
        if (shouldRefreshPic(pluginSong.pic, current.pic)) {
            patch.pic = await resolvePluginSongPic(pluginSong.pic)
        }

        const upd = await updateSong(songId, patch)
        if (!isOk(upd)) return fail(upd.error)
        // 本次只改 patch 内的字段，其余仍是读到的值 → 直接合并返回
        return ok({ ...current, ...patch })
    }

    const song = {
        id: generateId('song'),
        pluginId: pluginSong.pluginId,
        pluginSongId: pluginSong.id,
        isLiked: false,
        downloadQualities: [],
        meta: clone(pluginSong),
        createdAt: formatDate(),
        updatedAt: formatDate(),
        ...buildSongPatch(pluginSong),
        pic: await resolvePluginSongPic(pluginSong.pic),
    } as LP.Song

    const r = await createSong(song as Omit<LP.Song, 'createdAt' | 'updatedAt'>)
    if (!isOk(r)) return fail(r.error)
    return ok(song)
}

/**
 * 用插件返回的（部分）歌曲数据更新已有歌曲。id 为程序内歌曲 id（generateId 生成）。
 * 列字段仅映射插件侧存在的字段，未提供的保持原值；
 * meta 快照按浅合并写回，pic 仅在 URL 变化或缓存缺失时重建。
 */
export async function updateSongFromPlugin(
    programSongId: string,
    patch: Partial<LP.Plugin.Song>,
): Promise<Result<unknown>> {
    const currentR = await getSongById(programSongId)
    if (!isOk(currentR)) return fail(currentR.error)
    if (!currentR.value) return fail('歌曲不存在')
    const current = currentR.value

    const mapped = buildSongPatch(patch)
    // meta 是插件原始数据的快照：这里入参是「部分」数据，故按浅合并写回 ——
    // 本次提供的字段整体替换（不深合并，免得旧对象的残留键混进来），未提供的字段保留。
    mapped.meta = { ...(current.meta ?? {}), ...clone(patch) }
    if (shouldRefreshPic(patch.pic, current.pic)) {
        mapped.pic = await resolvePluginSongPic(patch.pic)
    }

    const r = await updateSong(programSongId, mapped)
    if (!isOk(r)) return fail(r.error)
    return ok(true)
}

/**
 * 确保歌曲已入库并返回 LP.Song。
 * - 已入库 → 直接读库返回；
 * - 未入库 → createSongFromPlugin 落库。
 */
export async function ensureSong(
    pluginSong: LP.Plugin.Song,
    knownId?: string,
): Promise<Result<LP.Song>> {
    if (knownId) {
        const r = await getSongById(knownId)
        if (isOk(r) && r.value) return ok(r.value)
    }
    return createSongFromPlugin(pluginSong)
}

/**
 * 从本地音频文件创建歌曲
 * 本地歌曲标识：pluginId='local'，pluginSongId=文件路径（即播放路径），
 */
export async function createSongFromLocalFile(filePath: string): Promise<Result<LP.Song>> {
    // 1. 查重：本地歌曲以 plugin_id='local' + pluginSongId=文件路径 为自然键
    const existing = await dbFind('songs', { pluginId: 'local', pluginSongId: filePath })
    if (!isOk(existing)) return fail(existing.error)
    if (existing.value) {
        const song = await getSongById(existing.value.id as string)
        if (isOk(song) && song.value) return ok(song.value)
    }

    // 2. 解析元数据 + 文件信息
    const metaR = await parseAudioMetadata(filePath)
    if (!isOk(metaR)) return fail(metaR.error)
    const meta = metaR.value
    const info = await getFileInfo(filePath)
    const size = info?.size ?? 0

    // 2.5 时长兜底：music-metadata 取不到（0）或明显偏小（<10s）时，再用 <audio> 的 duration 二次解析。
    //     探针返回 0 表示解析失败 → 保留原值（哪怕原值偏小也比 0 好）。
    const metaDuration = Number(meta.format.duration ?? 0)
    let duration = Number.isFinite(metaDuration) ? Math.floor(metaDuration) : 0
    if (duration < 10) {
        const probed = await parseDurationWithAudio(filePath)
        if (probed > 0) duration = probed
    }

    // 3. 文件名解析（歌名-歌手 / 歌手-歌名），失败回退到元数据
    const fileName = (info?.name ?? filePath).replace(/\.[^/.]+$/, '')
    const { name, singer, album } = deriveLocalSongFields(fileName, meta)

    // 4. 图片：从元数据抽取内嵌封面[0] → 渲染端落盘到缓存目录 SongPic/
    let pic: { url: string; path: string } | undefined
    const picture = meta.common.picture?.[0]
    if (picture) {
        const path = await cacheSongPicture(picture.data, picture.format)
        pic = { url: '', path }
    }

    // 5. 音质与大小
    const qualityType = formatQuality({
        br: meta.format.bitrate ?? 0,
        sr: meta.format.sampleRate ?? 0,
        bd: meta.format.bitsPerSample ?? 0,
        codec: meta.format.codec ?? '',
        format: meta.format.container ?? '',
    })
    const supportQualities = [{ type: qualityType, size: formatSize(size) }]
    const downloadQualities = [{ type: qualityType, size: formatSize(size), path: filePath }]

    const song = {
        id: generateId('song'),
        pluginId: 'local',
        pluginSongId: filePath,
        name,
        namePinyin: pinyin(name, { toneType: 'none' }),
        album,
        albumPinyin: album ? pinyin(album, { toneType: 'none' }) : undefined,
        singer,
        singerPinyin: singer ? pinyin(singer, { toneType: 'none' }) : undefined,
        pic,
        duration,
        isLiked: false,
        downloadQualities,
        supportQualities,
        meta: {},
        createdAt: formatDate(),
        updatedAt: formatDate(),
    } as LP.Song

    const r = await createSong(song as Omit<LP.Song, 'createdAt' | 'updatedAt'>)
    if (!isOk(r)) return fail(r.error)
    eventBus.emit(LP_EVENT['SONG.CREATED'], song)
    return ok(song)
}
