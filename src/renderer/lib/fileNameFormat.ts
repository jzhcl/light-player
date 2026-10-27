/**
 * 下载文件名格式 —— 选项制（枚举），生成与反向解析共用同一份定义。
 *
 * ## 音质后缀的不对称（有意为之）
 *
 *  - 生成必加：同一首歌下载多个音质时，文件名必须区分，否则互相覆盖。
 *    标准音质为空（`_H`/`_S`/`_R`/`_M` 仅非标准音质）。
 *  - 解析只当 hint，不当真相：解析面对的文件大多是用户自己的音乐库，
 *    压根没有 `_H`；真正普适的音质来源是 `parseAudioMetadata`（比特率/采样率）。
 *    所以后缀不参与字段切分，切分前从整串尾部顺手剥掉，剥不掉就原样保留。
 */
import { useSettingsStore } from '@renderer/store'

/** 音质简写（HQ→H、SQ→S、Hi-Res→R、Master→M） */
export type QualityAbbr = 'H' | 'S' | 'R' | 'M'

/** 音质后缀形态：`_H` / `_S` / `_R` / `_M`。解析时从整串尾部尝试剥离。 */
const QUALITY_SUFFIX_RE = /_[HSRM]$/

/** 反向解析结果：能拆出哪段算哪段（缺的为空串）。 */
interface ParsedFileName {
    name: string
    singer: string
    album: string
}

/**
 * 文件名格式的选项值
 */
export type FileNameFormat = LP.RendererSetting['download.fileNameFormat']

/** 格式定义项 */
interface FormatDef {
    /** 反向解析用的整串正则 */
    pattern: RegExp
    /** 生成用拼装（入参顺序固定：歌手、专辑、歌名；不需要的字段用 `_` 前缀占位） */
    render: (singer: string, album: string, name: string) => string
}

/**
 * 拼「A - B」：任一侧为空就整条省掉分隔符。
 *
 * 目的：避免孤儿分隔符 —— 歌曲没有专辑时若照拼会得到 `歌手_ - 歌名`，
 * 这种名字连它自己的格式都解析不回去（整串落成歌名）。缺字段就让分隔符消失。
 */
const joinDash = (a: string, b: string): string => (a && b ? `${a} - ${b}` : a || b)

/** 拼「A_B」：理由同 `joinDash`（专辑缺省时不该留下孤立的 `_`）。 */
const joinUnderscore = (a: string, b: string): string => (a && b ? `${a}_${b}` : a || b)

/**
 * 格式定义表
 *
 * `pattern` 只负责切出 name/singer/album 三段；不含音质后缀。
 *
 * 专辑可省略
 *
 * 下载时歌曲可能没有专辑信息。此时：
 *  - 生成：不写专辑段、也不留分隔符 —— `singer_album-name` 与 `singer-name(album)`
 *    退化成 `歌手 - 歌名`，`name-` 系退化成 `歌名 - 歌手`，由 `joinDash` / `joinUnderscore` 保证。
 *  - 解析：专辑段在 pattern 里整体写成可选（`(?:_(?<album>…))?` / `(?:（(?<album>…）)?`），
 *    于是「省略形态」与「完整形态」共用同一条 pattern。
 *
 * ⚠️ `singer-name(album)` 与 `name-singer(album)` 在字符层面同构（都只有一个 ` - ` + 可选尾部括号），
 * 谁在左只能由设置项（用户的命名习惯）决定 —— 不要试图从字符串推断方向，判不出来。
 *
 * 量词选择
 *
 * 分隔符是 `_` / ` - ` / `（）`，而字段内容里也可能出现同样的字符
 * （歌名 `晴天 - 现场版`、歌手 `A - B`）。JS 正则的 `.+` 默认贪婪，
 * 会让靠前的段抢走本该属于后面的内容。所以：
 *
 *  - 靠前的段用懒惰 `.+?`：它在遇到第一个分隔符时就停，把剩余内容留给后面。
 *  - 最后一段（`name`，或括号形态里 `）` 前的段）用贪婪 `.+`：
 *    它要吃下所有剩余内容，懒惰会让引擎只吃 1 个字符。
 *
 * ⚠️ 专辑段一律写成不含分隔符的 `[^_]*` / `[^（）]*` —— 这样它只能吃到
 * 「最后一个 `_` 之后」/「最后一对括号」，即专辑匹配最后一项：
 *  - `A_B_专 - 歌` → singer=`A_B` / album=`专`
 *  - `陈 - 天路（Live）（专）` → name=`天路（Live）` / album=`专`
 * 代价是专辑名自身含 `_`/括号时会切错 —— 那时它与歌手/歌名的边界无从判断，只能保一边。
 */
const FORMAT_DEFS: Record<FileNameFormat, FormatDef> = {
    'singer_album-name': {
        pattern: /^(?<singer>.+?)(?:_(?<album>[^_]*))? - (?<name>.+)$/,
        render: (singer, album, name) => joinDash(joinUnderscore(singer, album), name),
    },
    'name-singer_album': {
        pattern: /^(?<name>.+?) - (?<singer>.+?)(?:_(?<album>[^_]*))?$/,
        render: (singer, album, name) => joinDash(name, joinUnderscore(singer, album)),
    },
    'singer-name(album)': {
        pattern: /^(?<singer>.+?) - (?<name>.+?)(?:（(?<album>[^（）]*)）)?$/,
        render: (singer, album, name) => joinDash(singer, name) + (album ? `（${album}）` : ''),
    },
    'name-singer(album)': {
        pattern: /^(?<name>.+?) - (?<singer>.+?)(?:（(?<album>[^（）]*)）)?$/,
        render: (singer, album, name) => joinDash(name, singer) + (album ? `（${album}）` : ''),
    },
}

/**
 * 全部格式，按 `FORMAT_DEFS` 的声明顺序（设置页下拉的选项顺序即此顺序）。
 */
export const FILE_NAME_FORMATS: FileNameFormat[] = Object.keys(FORMAT_DEFS) as FileNameFormat[]

/** 判断一个字符串是否是合法的格式选项 */
function isFileNameFormat(v: unknown): v is FileNameFormat {
    return typeof v === 'string' && v in FORMAT_DEFS
}

/** 读当前设置里的格式；非法 / 缺失时回落默认。 */
export function getCurrentFileNameFormat(): FileNameFormat {
    const stored = useSettingsStore.getState().settings['download.fileNameFormat']
    return isFileNameFormat(stored) ? stored : 'singer_album-name' // 默认格式
}

/** Windows 文件名非法字符（生成时会替换成 `_`） */
const ILLEGAL_CHARS_RE = /[\\/:*?"<>|]/g

const sanitize = (s: string): string => (s ?? '').replace(ILLEGAL_CHARS_RE, '_').trim()

/** 生成文件名时的字段值。 */
interface FileNameVars {
    name: string
    singer: string
    album: string
    /** 音质后缀简写（标准音质传空串）。 */
    quality: QualityAbbr | ''
    /** 扩展名（不含点，如 `mp3`）。 */
    ext: string
}

/**
 * 按格式渲染文件名（含扩展名，后缀已并入）。非法字符替换成 `_`。
 *
 * 分隔符由 `FORMAT_DEFS[format].render` 提供 —— 与同项的 `pattern` 一一对应，
 * 改一个必须同步改另一个，否则生成与解析会漂移。
 */
export function renderFileName(format: FileNameFormat, v: FileNameVars): string {
    const base = (FORMAT_DEFS[format] ?? FORMAT_DEFS['singer_album-name']).render(
        sanitize(v.singer),
        sanitize(v.album),
        sanitize(v.name) || 'song',
    )
    const q = v.quality ? `_${v.quality}` : ''
    return `${base}${q}.${sanitize(v.ext) || 'mp3'}`
}

/**
 * 按格式反向解析本地文件名（不含扩展名，调用方需先剥掉）→ `{ name, singer, album }`。
 *
 * 后缀只是 hint：真实音质由调用方用音频元数据推导，这里剥不掉就原样保留。
 *
 * - 不匹配时整体当 `name`（最差情况只保 name，不报错）。
 */
export function parseFileNameByFormat(fileName: string, format: FileNameFormat): ParsedFileName {
    // 1. 先剥后缀
    const raw = fileName.trim().replace(QUALITY_SUFFIX_RE, '').trim()
    const result: ParsedFileName = { name: '', singer: '', album: '' }

    // 2. 再按格式切分
    const m = FORMAT_DEFS[format]?.pattern.exec(raw)
    if (m?.groups) {
        result.name = (m.groups.name ?? '').trim()
        result.singer = (m.groups.singer ?? '').trim()
        result.album = (m.groups.album ?? '').trim()
    }

    // 3. 保底：只保 name
    if (!result.name) result.name = raw

    return result
}

/** 音频元数据里与本解析相关的字段。 */
interface LocalSongMeta {
    common: { title?: string | null; artists?: string[]; album?: string | null }
}

/**
 * 从「文件名 + 元数据」推导歌名 / 歌手 / 专辑。
 *
 * 元数据优先，文件名只兜底
 *
 * 三个字段的来源顺序
 *  - `name`  ：`title`（元数据）→ 文件名解析（其内部再兜底成整个文件名）
 *  - `singer`：`artists`（元数据）→ 文件名解析
 *  - `album` ：`album`（元数据）→ 文件名解析 → 空
 *
 * ⚠️ **脏标签**：下载器常把整串文件名写进 `title`。这种 title 与文件名完全相同，
 * 是「标签由文件名生成」的指纹 —— 命中时判定它不可信，仍走文件名解析。
 */
export function deriveLocalSongFields(
    fileName: string,
    meta: LocalSongMeta
): { name: string; singer: string; album: string } {
    // 文件名解析结果
    const parsed = parseFileNameByFormat(fileName, getCurrentFileNameFormat())
    const artists = (meta.common.artists ?? []).join(' & ')
    const title = meta.common.title?.trim() ?? ''
    const album = meta.common.album?.trim() ?? ''
    // 整串文件名被塞进 title 时不可信
    const titleTrusted = title !== '' && title !== fileName.trim()

    return {
        name: titleTrusted ? title : parsed.name,
        singer: artists || parsed.singer,
        album: album || parsed.album || '',
    }
}
