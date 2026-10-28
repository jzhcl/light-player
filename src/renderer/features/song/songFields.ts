import { pinyin } from 'pinyin-pro'
import { formatSize } from '@shared/format'

/**
 * 歌曲字段派生（纯函数，无 IO）。
 *
 * 所有「来源数据 → `LP.Song` 列字段」的推导都收在这里：插件返回的原始数据、
 * 本地文件名解析的结果。拼音只在写库前算一次，落库后不再重算；因此这里也是
 * 唯一依赖 `pinyin-pro` 的地方。
 */

/** 拼音（不带声调）；空值返回 undefined */
function py(text?: string): string | undefined {
    return text ? pinyin(text, { toneType: 'none' }) : undefined
}

/**
 * 把插件歌曲数据映射为 `LP.Song` 的可更新字段。
 * 仅映射插件侧存在的字段（`undefined` 跳过），创建与更新共用。
 */
export function buildSongPatch(pluginSong: Partial<LP.Plugin.Song>): Partial<LP.Song> {
    const patch: Partial<LP.Song> = {}
    if (pluginSong.name !== undefined) {
        patch.name = pluginSong.name
        patch.namePinyin = py(pluginSong.name)
    }
    if (pluginSong.album !== undefined) {
        patch.album = pluginSong.album?.name
        patch.albumPinyin = py(pluginSong.album?.name)
    }
    if (pluginSong.singer !== undefined) {
        patch.singer = pluginSong.singer.map((s) => s.name).join(' & ')
        patch.singerPinyin = pluginSong.singer.map((s) => py(s.name)).join(' & ')
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

/** 本地歌名字段 + 拼音 */
export function buildLocalSongFields(fields: {
    name: string
    singer?: string
    album?: string
}): Pick<LP.Song, 'name' | 'namePinyin' | 'singer' | 'singerPinyin' | 'album' | 'albumPinyin'> {
    return {
        name: fields.name,
        namePinyin: py(fields.name),
        singer: fields.singer ?? '',
        singerPinyin: py(fields.singer),
        album: fields.album,
        albumPinyin: py(fields.album),
    }
}

/**
 * 入库时的封面状态：只记在线地址，不下载。
 *
 * `path: ''` 就是「待物化」的标记 —— 三态说明见 `coverPipeline.ts` 顶部。
 */
export function pendingPic(picUrl?: string): LP.Song['pic'] {
    return picUrl ? { url: picUrl, path: '' } : undefined
}

/** 是否需要重新物化封面：URL 变了，或上次没落成（`path` 为空） */
export function shouldRefreshPic(picUrl: string | undefined, current?: LP.Song['pic']): boolean {
    return !!picUrl && (picUrl !== current?.url || !current?.path)
}
