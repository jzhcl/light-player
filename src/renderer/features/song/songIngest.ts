import { createSong, dbFind, getSongById } from '@renderer/lib/db'
import { formatDate, formatQuality, formatSize } from '@shared/format'
import { eventBus, LP_EVENT } from '@renderer/lib/eventBus'
import { fail, isOk, ok } from '@shared/result'
import { clone, generateId } from '@shared/utils'
import { getFileInfo } from '@renderer/lib/file'
import { parseAudioMetadata, parseDurationWithAudio } from '@renderer/lib/audio'
import { deriveLocalSongFields } from '@renderer/lib/fileNameFormat'
import { buildLocalSongFields, buildSongPatch, pendingPic, shouldRefreshPic } from './songFields'
import { updateSong } from './songWrite'
import { enqueueCover } from './coverPipeline'

/**
 * 歌曲入库：把「插件返回的歌曲」或「本地音频文件」变成库里的行。
 *
 *  - 按自然键查重（插件 = pluginId + pluginSongId；本地 = 'local' + 文件路径），
 *    已存在就走更新而不是插入
 *  - 创建路径零封面 IO：只写「待物化」状态，落盘交给封面管道
 *  - 插入新歌必须发 `SONG.CREATED`（列表页靠它插行）；已存在的歌走 `SONG.UPDATED`
 */

/**
 * 从插件返回的歌曲数据创建 `LP.Song` 并入库。
 * 已存在同一自然键的歌 → 刷新字段（含 meta 快照）后返回。
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
            patch.pic = pendingPic(pluginSong.pic)
        }

        const upd = await updateSong(songId, patch)
        if (!isOk(upd)) return fail(upd.error)
        // 本次只改 patch 内的字段，其余仍是读到的值 → 直接合并返回
        const merged = { ...current, ...patch }
        enqueueCover(merged)
        return ok(merged)
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
        pic: pendingPic(pluginSong.pic),
    } as LP.Song

    const r = await createSong(song as Omit<LP.Song, 'createdAt' | 'updatedAt'>)
    if (!isOk(r)) return fail(r.error)
    eventBus.emit(LP_EVENT['SONG.CREATED'], song)
    enqueueCover(song)
    return ok(song)
}

/**
 * 用插件返回的（部分）歌曲数据更新已有歌曲。id 为程序内歌曲 id（generateId 生成）。
 * 列字段仅映射插件侧存在的字段，未提供的保持原值；
 * meta 快照按浅合并写回，pic 仅在 URL 变化或缓存缺失时重新排队物化。
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
        mapped.pic = pendingPic(patch.pic)
    }

    const r = await updateSong(programSongId, mapped)
    if (!isOk(r)) return fail(r.error)
    enqueueCover({ ...current, ...mapped })
    return ok(true)
}

/**
 * 确保歌曲已入库并返回 `LP.Song`。
 * - 已入库 → 直接读库返回；
 * - 未入库 → `createSongFromPlugin` 落库。
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
 * 从本地音频文件创建歌曲。
 * 本地歌曲标识：`pluginId='local'`，`pluginSongId` = 文件路径（也就是播放路径）。
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
    const fields = deriveLocalSongFields(fileName, meta)

    // 4. 封面：这次解析只告诉该歌曲「有几张内嵌图」，图片字节不出主进程。
    //    有图 → 标成待物化，由封面管道稍后抽取落盘
    const pic: LP.Song['pic'] = meta.common.pictureCount ? { url: '', path: '' } : undefined

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
        ...buildLocalSongFields(fields),
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
    enqueueCover(song)
    return ok(song)
}
