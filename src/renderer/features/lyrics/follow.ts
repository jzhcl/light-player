/**
 * 桌面歌词「溢出跟随」的演算部分。
 *
 * 场景：当前行比视口宽时把整行做水平位移，让正在唱的那个词停在视口中心。
 * 视口 = 歌词行盒（`nowrap + overflow:hidden`），位移作用在内层的滑动层上。
 *
 * 为什么「不溢出就一律不位移」：不溢出时行盒自己就贴着内容、位置由外层对齐决定，
 * 位移恒为 0 才不会跟既有对齐方式（居中 / 左右分离）打架。
 */

/**
 * 位移平滑的时间常数（毫秒）。
 *
 * ① 抹平词与词之间速度的阶跃；② 吸收 `karaokeClock` 4Hz 柔性校正带来的微跳。
 * 因此可以取小 —— 越大越"拖尾"，而这里的拖尾会直接表现为「当前词落后于视口中心」。
 */
export const FOLLOW_TAU_MS = 120

/**
 * 当前该居中的是第几个词：最后一个「已开始」（`start <= tMs`）的词。
 * 早于第一个词 → 0（行还没开唱时停在行首）；词表为空 → 0，由调用方兜底。
 */
export function activeWordIndex(words: LyricWordSeg[], tMs: number): number {
    let index = 0
    for (let i = 0; i < words.length; i++) {
        if (words[i].start > tMs) break
        index = i
    }
    return index
}

/**
 * 连续锚点 —— 这是「手感」的来源。
 *
 * 锚点 = 「整行上应该落在视口中心的那个坐标」。它不能等于「当前词的中心」：
 * 那是逐词跳变的，每个词跳一个词距（CJK 约 30px，英文词更大）→ 平滑器把它
 * 抹成「跳一下、停半拍、再跳一下」，词密时就成了频繁的小幅快跳。
 *
 * 改法：让锚点成为时间上的连续分段线性函数，结（knot）取在每个词的时间中点上，
 * 即 `anchor(mid_k) === centers[k]`，段内线性插值到下一个结。
 *
 * ⚠️ 为什么结取中点而不是词起点 —— 在「段内匀速」这个前提下，一个词从开唱到唱完
 * 位移必然等于一个词距（无法更小），所以「当前词偏离视口中心的最大值」完全由结的位置
 * 决定：
 *   - 结在词起点 → 开唱时正中、唱完时偏出一整个词距；
 *   - 结在词中点 → 开唱时偏出半个、中点正中、唱完再偏出半个 —— 严格更小，
 *     且「对称放置」已是该前提下的下界（最大偏离 = 半个词距，不可能再小）。
 * 手感完全不变：段内速度 = 词距 ÷ 相邻两词中点的间距 —— 与词起点结同速。
 * （附带好处：中点点距 = 相邻两词时长的均值 → 词长忽长忽短时速度波动反而更小。）
 *
 * 代价（必须有意识地接受）：当前词只在它自己的中点压在视口中心，两侧各偏出半个词距。
 * 匀速滑动与「当前词恒居中」本质不可兼得，本次选了滑动。
 */
export function followAnchor(words: LyricWordSeg[], centers: number[], tMs: number): number {
    const last = words.length - 1
    if (last < 0) return centers[0] ?? 0

    const mid = (i: number): number => (words[i].start + words[i].end) / 2
    const k = activeWordIndex(words, tMs)

    // 词 k 已过自己的中点 → t 落在 [mid_k, mid_{k+1}]；否则落在 [mid_{k-1}, mid_k]。
    // 两个区段都是「结 → 结」的线性段，取左端结的序号 j。
    const j = tMs >= mid(k) ? k : k - 1
    if (j < 0) return centers[0] ?? 0 // 首词中点之前：停在行首
    if (j >= last) return centers[last] ?? 0 // 末词中点之后：没有下一个结

    const span = mid(j + 1) - mid(j)
    if (span <= 0) return centers[j] ?? 0 // 零时长词的退化兜底

    const from = centers[j] ?? 0
    const to = centers[j + 1] ?? from
    return from + (to - from) * ((tMs - mid(j)) / span)
}

/**
 * 求滑动层的水平位移（px）。
 *
 * - 不溢出 → 0：位置交给外层对齐。
 * - 溢出 → 把 `wordCenter` 顶到视口中心，两端 clamp 卡住：首词贴左、末词贴右
 *   （不卡的话行首行尾会滑出视口露出空白）。
 *
 * @param view       视口宽（行盒 clientWidth）
 * @param lineWidth  整行宽（滑动层 offsetWidth）
 * @param wordCenter 目标词中心，相对滑动层左边缘
 */
export function followOffset(view: number, lineWidth: number, wordCenter: number): number {
    if (lineWidth <= view) return 0
    const centerAligned = view / 2 - wordCenter
    const limit = view - lineWidth
    if (centerAligned > 0) return 0
    return centerAligned < limit ? limit : centerAligned
}

/**
 * 指数平滑走一步：把 current 朝 target 推进 dtMs 对应的一步。
 *
 * `dtMs <= 0` 直接落位 —— 这正是老项目抖动的解药：换行时新一行的位移不许从
 * 上一行的位置过渡过来，必须直接落到目标上（见 KaraokeLine 里的「时间戳归零」）。
 */
export function stepOffset(current: number, target: number, dtMs: number): number {
    if (dtMs <= 0) return target
    return current + (target - current) * (1 - Math.exp(-dtMs / FOLLOW_TAU_MS))
}
