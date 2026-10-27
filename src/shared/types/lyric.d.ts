/**
 * 歌词引擎的公共类型。时间单位统一为毫秒——播放器 store 里的 currentTime 是秒，
 * 只允许在进入引擎的边界处换算一次，引擎内部不再出现秒。
 */

/** 一行歌词 */
interface LyricLine {
    /** 行开始时间（毫秒）。offset 已在解析时折算进来 */
    time: number
    /** 行内容；空串表示间奏等无词行 */
    text: string
}

/** LRC 头部标签集合。除 offset 归一化为数字外，其余按原文保留字符串。 */
interface LrcMetadata {
    /** 时间偏移（毫秒）。正值表示歌词整体提前显示 */
    offset: number
    [tag: string]: string | number
}

/** 播放位置在歌词中的落点 */
interface LyricState {
    /** 当前行索引；-1 表示尚未进入任何行 */
    lineIndex: number
    /** 当前词索引；非逐字模式为 -1 */
    wordIndex: number
    /** 当前词播放进度 0-1；非逐字模式下为 0 */
    progress: number
}

/**
 * 逐字分词段。`text` 已按「相邻非 CJK 词之间补空格」的规则加工过——KRC 的词切分
 * 不含空格，英文按词切开后直接拼接会粘连。
 */
interface LyricWordSeg {
    /** 词文本（可能带一个补出来的尾随空格） */
    text: string
    /** 词开始时间（毫秒） */
    start: number
    /** 词结束时间（毫秒）。插件侧只给 duration，入库时已补齐 */
    end: number
}

/**
 * 渲染用的一行。
 *
 * LRC 行与 KRC 行是两套不同的结构（行数、时间、索引空间都可能不一样），这里把它们
 * 归一成同一种形状：调用方只认 `lines[i]`，不必知道当前是哪种歌词模式，也不必
 * 关心索引落在哪套数组上。`words` 为 null 即「这一行没有逐字数据」，渲染整行即可。
 */
interface LyricDisplayLine {
    /** 行开始时间（毫秒），用于点行 seek */
    time: number
    /** 整行文本（KRC 行为各词拼接结果）；空串表示间奏等无词行 */
    text: string
    /** 与该行对齐的翻译文本；无翻译为 null */
    translation: string | null
    /** 与该行对齐的罗马音文本；无罗马音为 null */
    roma: string | null
    /** 逐字分词；null 表示无逐字数据（LRC 模式，或 KRC 里的纯空白行） */
    words: LyricWordSeg[] | null
}
