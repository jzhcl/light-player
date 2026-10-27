import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ScrollArea } from '@renderer/components/ui/ScrollArea'
import { useNavigateTo } from '@renderer/hooks/useNavigateTo'
import {
    fetchHotSearch,
    fetchSuggestions,
    type SearchSuggestion,
    type SuggestionGroup,
} from '@renderer/features/search/searchSuggestService'

/** 建议面板与搜索框的垂直间距 */
const PANEL_GAP = 6
/** 建议面板高度上限（建议项过多时不无限拉长） */
const PANEL_MAX_H = 320
/** 面板底边与视口底部的安全边距 */
const PANEL_VIEWPORT_MARGIN = 12
/** 视口极矮时仍保证的最小可滚动高度 */
const PANEL_MIN_H = 120
/** 键盘导航滚动时高亮项与视口边缘保留的余量（与列表内边距一致，滚到端点时露出留白） */
const SCROLL_EDGE_PAD = 6

export interface SearchBoxProps {
    /**
     * 设置项开启且搜索区未被悬停唤起 → true：空闲态（无文字、未聚焦）整体淡出，
     * 把位置让给标题栏的歌曲状态。聚焦 / 有文字时它自己回来。
     */
    concealed?: boolean
    /** 空闲态变化通知：父级据此同步歌曲状态层的显隐 */
    onIdleChange?: (idle: boolean) => void
}

export const SearchBox = React.memo(function SearchBox({ concealed = false, onIdleChange }: SearchBoxProps) {
    const navigateTo = useNavigateTo()
    const rootRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const listRef = useRef<HTMLDivElement>(null)
    // ScrollArea 内部滚动视口：键盘导航时直接驱动它的 scrollTop
    const scrollViewRef = useRef<HTMLDivElement | null>(null)
    // 文本预览层的内层元素：承载与 input 横向滚动同步的 transform
    const previewRef = useRef<HTMLSpanElement>(null)
    // 请求序号：丢弃过期响应（热搜/建议均为异步，快速切换时后发先至会串台）
    const reqRef = useRef(0)
    // 本次 activeIndex 变更是否来自键盘导航：只有键盘导航才需要把高亮项滚入可视区。
    // 鼠标滚轮滚动时条目会从指针下方经过、连带触发 mouseenter 改高亮，
    // 若也跟着滚动就会把用户刚滚的位置往回拽。
    const navByKeyRef = useRef(false)

    const [value, setValue] = useState('')
    const [groups, setGroups] = useState<SuggestionGroup[]>([])
    const [open, setOpen] = useState(false)
    const [focused, setFocused] = useState(false)
    /**
     * 本轮聚焦里「用户是否动过搜索框」（鼠标按下 / 键盘输入）—— 建议面板只在它为真时才弹。
     *
     * 另：鼠标按在输入框上但已经聚焦时不会产生 focus 事件 → 只有 mousedown 能覆盖
     * 「按 Escape 收起后想再点开」这种情形，所以意图来源必须落在 mousedown 上。
     */
    const [userActive, setUserActive] = useState(false)
    // IME 合成中：此时把文字渲染交还给 input 自己（保留候选下划线），预览层让位
    const [composing, setComposing] = useState(false)
    const [activeIndex, setActiveIndex] = useState(-1)
    const [cursorAtEnd, setCursorAtEnd] = useState(true)
    // 展开过渡动画：mounted=是否挂载在 DOM，shown=是否处于“已展开”态（驱动 CSS 过渡）
    const [mounted, setMounted] = useState(false)
    const [shown, setShown] = useState(false)

    const uid = useId()
    const LISTBOX_ID = `${uid}-listbox`
    const optionId = (i: number) => `${uid}-option-${i}`
    const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number }>({
        top: 0,
        left: 0,
        width: 0,
    })
    // 面板高度：实时计算后以 px 写入 inline style
    const [panelHeight, setPanelHeight] = useState(0)

    // 扁平索引（组标题不可选中，导航只在项之间）
    const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

    // 空闲态：无输入文字、未聚焦、本轮无用户操作。设置项开启且搜索区未被悬停唤起时
    // 整体淡出，位置让给标题栏的歌曲状态。
    const idle = !value && !focused && !userActive
    useEffect(() => {
        onIdleChange?.(idle)
    }, [idle, onIdleChange])

    /**
     * 匹配预览（ghost 后缀）：光标在末尾 + 该项以输入为前缀 → 显示剩余后缀为幽灵文字。
     * 预览只描述「按 Tab/→ 会补成什么」，不代表回车会搜它。
     */
    const ghostSuffix = useMemo(() => {
        if (!open || !cursorAtEnd || composing) return ''
        const v = value.toLowerCase()
        if (!v) return ''
        const s = activeIndex >= 0 ? flat[activeIndex] : flat.find((it) => it.text.toLowerCase().startsWith(v))
        if (!s || !s.text.toLowerCase().startsWith(v)) return ''
        return s.text.slice(value.length)
    }, [open, cursorAtEnd, composing, activeIndex, flat, value])

    // 以「搜索框容器」而非 input 为基准定位：border 挂在容器上、容器还有左右 padding，
    // 用 input 的 rect 会让面板窄 22px 并整体右移，导致左右两侧都对不齐。
    const reposition = useCallback(() => {
        const el = rootRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        setPanelPos({ top: rect.bottom + PANEL_GAP, left: rect.left, width: rect.width })
    }, [])

    /**
     * 建议数据来源：聚焦且输入框无文本 → 插件热搜；
     * 有文本 → 插件搜索建议 + 本地建议（防抖 150ms）。
     * 两道门：
     *  ① `focused` —— 未聚焦一律不拉取，这同时保证「执行搜索后（已 blur）不会因 value
     *     变更把面板重新弹出」；
     *  ② `userActive` —— 非用户聚焦不拉取。它同时是「本轮意图」的
     *     开关：置真会让本 effect 重跑，所以「已聚焦时再点一下」也能重新展开面板。
     */
    useEffect(() => {
        if (!focused || !userActive) return
        const kw = value.trim()
        const seq = ++reqRef.current

        const apply = (g: SuggestionGroup[]) => {
            if (seq !== reqRef.current) return
            setGroups(g)
            // 不自动高亮任何建议项：选中态必须由用户显式操作（↓/↑/hover）产生
            setActiveIndex(-1)
            // 仅在有建议时展开容器（无建议不显示容器）
            setOpen(g.length > 0)
            reposition()
        }

        if (!kw) {
            void fetchHotSearch().then(apply)
            return
        }
        const t = setTimeout(() => {
            void fetchSuggestions(kw).then(apply)
        }, 150)
        return () => clearTimeout(t)
    }, [value, focused, userActive, reposition])

    // 展开/收起过渡：根据“是否应有建议面板”驱动挂载与动画态
    const shouldShowPanel = open && groups.length > 0
    useEffect(() => {
        if (shouldShowPanel) {
            setMounted(true)
            const raf = requestAnimationFrame(() => setShown(true))
            return () => cancelAnimationFrame(raf)
        }
        setShown(false)
        const t = setTimeout(() => setMounted(false), 160)
        return () => clearTimeout(t)
    }, [shouldShowPanel])

    /**
     * 面板高度实时计算：
     * ScrollArea 内部滚动元素依赖 height:100% 建立可滚动视口，而百分比高度在
     * 父级高度为 auto（max-height 只是上限、计算值仍是 auto）时无法解析，
     * 结果是滚动视口塌陷成内容高度 → 永远不溢出 → 滚不动。
     * 因此这里量出内容自然高度，与上限/视口余量取小后以 px 写入面板，
     * 使 height 成为确定值，内部 height:100% 才能生效。
     */
    useLayoutEffect(() => {
        if (!mounted) return
        const list = listRef.current
        const panel = panelRef.current
        if (!list || !panel) return
        const avail = window.innerHeight - panelPos.top - PANEL_VIEWPORT_MARGIN
        const limit = Math.max(Math.min(PANEL_MAX_H, avail), PANEL_MIN_H)
        // 面板是 border-box：写入的 height 含边框，须把上下边框补进去，
        // 否则内容恒溢出 2px，出现一条无意义的滚动
        const border = panel.offsetHeight - panel.clientHeight
        // list 不受面板高度约束（溢出而非压缩），故 offsetHeight 恒为内容自然高度
        setPanelHeight(Math.min(list.offsetHeight + border, limit))
    }, [mounted, groups, panelPos.top])

    // 建议数据换了一批 → 列表回到顶部，否则新列表会莫名停在上一批滚过的位置
    useLayoutEffect(() => {
        if (scrollViewRef.current) scrollViewRef.current.scrollTop = 0
    }, [groups])

    /**
     * 打开时定位 + 监听滚动/缩放。
     * scroll 事件不冒泡，故必须用 capture 才能感知祖先容器的滚动；但 capture 会把
     * 「文档里任意元素的滚动」都收进来——包括面板自己的建议列表滚动、以及键盘导航
     * 把高亮项滚入可视区所产生的滚动，于是一滚就把面板关掉了。
     * 关闭的本意只是「锚点（搜索框）被祖先滚动带走 → 面板脱锚错位」，因此这里两道过滤：
     * ① 面板内部的滚动与锚点无关，直接忽略；
     * ② 滚动源必须是搜索框的祖先（含 document），否则也不影响定位。
     */
    useLayoutEffect(() => {
        if (!open) return
        reposition()
        const onScroll = (e: Event) => {
            const target = e.target as Node | null
            if (!target) return
            if (panelRef.current?.contains(target)) return
            if (!rootRef.current || !target.contains(rootRef.current)) return
            setOpen(false)
        }
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', reposition)
        return () => {
            window.removeEventListener('scroll', onScroll, true)
            window.removeEventListener('resize', reposition)
        }
    }, [open, reposition])

    // 外部点击关闭
    useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node
            if (rootRef.current?.contains(t) || panelRef.current?.contains(t)) return
            setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
    }, [open])

    /** 键盘导航时把高亮项滚入可视区（面板有最大高度，条目可能溢出） */
    useEffect(() => {
        if (!navByKeyRef.current) return
        navByKeyRef.current = false
        if (activeIndex < 0) return
        const view = scrollViewRef.current
        const el = panelRef.current?.querySelector<HTMLElement>('.searchbox-item.is-active')
        if (!view || !el) return
        const vr = view.getBoundingClientRect()
        const er = el.getBoundingClientRect()
        if (er.top < vr.top + SCROLL_EDGE_PAD) {
            view.scrollTop -= vr.top + SCROLL_EDGE_PAD - er.top
        } else if (er.bottom > vr.bottom - SCROLL_EDGE_PAD) {
            view.scrollTop += er.bottom - (vr.bottom - SCROLL_EDGE_PAD)
        }
    }, [activeIndex])

    // 文本超出输入框时 input 会横向滚动，预览层须同步偏移，否则文字与光标错位
    const syncPreviewScroll = useCallback(() => {
        const el = inputRef.current
        const preview = previewRef.current
        if (!el || !preview) return
        preview.style.transform = `translateX(${-el.scrollLeft}px)`
    }, [])

    useLayoutEffect(() => {
        syncPreviewScroll()
    }, [value, ghostSuffix, syncPreviewScroll])

    const syncCursor = useCallback(() => {
        const el = inputRef.current
        if (!el) return
        setCursorAtEnd(el.selectionStart === el.value.length && el.selectionEnd === el.selectionStart)
    }, [])

    const acceptGhost = useCallback(() => {
        if (!ghostSuffix) return false
        const text = value + ghostSuffix
        setValue(text)
        setActiveIndex(-1)
        requestAnimationFrame(() => {
            const el = inputRef.current
            if (el) {
                el.focus()
                el.setSelectionRange(text.length, text.length)
                setCursorAtEnd(true)
            }
        })
        return true
    }, [ghostSuffix, value])

    const runSearch = useCallback(
        (text: string) => {
            const q = text.trim()
            if (!q) return
            setOpen(false)
            navigateTo(`/search?q=${encodeURIComponent(q)}`)
            // 执行搜索后让输入框失焦
            inputRef.current?.blur()
        },
        [navigateTo],
    )

    /**
     * 选中建议项：收起面板、失焦，然后按该项自带的 path 跳转。
     * 跳转前对输入框的处理按来源而异：
     *  - 插件项 = 去执行这条搜索 → 填入词条，搜索框保留「搜的是什么」
     *  - 本地项 = 去「这首歌在哪」的页面（歌单/本地/最近播放）→ 清空输入框
     */
    const selectSuggestion = useCallback(
        (s: SearchSuggestion) => {
            setOpen(false)
            setValue(s.source === 'local' ? '' : s.text)
            inputRef.current?.blur()
            navigateTo(s.path)
        },
        [navigateTo],
    )

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        // IME 合成中：放行，不抢按键
        if (e.nativeEvent.isComposing || composing) return

        switch (e.key) {
            case 'ArrowDown': {
                e.preventDefault()
                if (flat.length === 0) return
                navByKeyRef.current = true
                // 走到末项后先回到“无选中”(-1)，再从首项继续，不直接轮回
                setActiveIndex((i) => (i >= flat.length - 1 ? -1 : i + 1))
                break
            }
            case 'ArrowUp': {
                e.preventDefault()
                if (flat.length === 0) return
                navByKeyRef.current = true
                // 走到首项后先回到“无选中”(-1)，再跳到末项，不直接轮回
                setActiveIndex((i) => (i < 0 ? flat.length - 1 : i - 1))
                break
            }
            case 'Tab': {
                // 面板展开时把焦点锁在输入框内：有匹配预览则采纳补全，否则仅阻止焦点逃逸
                if (open) {
                    e.preventDefault()
                    acceptGhost()
                }
                break
            }
            case 'ArrowRight': {
                // 光标在末尾且有匹配项 → 补全（否则放行光标右移）
                if (ghostSuffix && cursorAtEnd) {
                    e.preventDefault()
                    acceptGhost()
                }
                break
            }
            case 'Enter': {
                e.preventDefault()
                if (activeIndex >= 0 && activeIndex < flat.length) {
                    selectSuggestion(flat[activeIndex])
                } else {
                    runSearch(value)
                }
                break
            }
            case 'Escape': {
                e.preventDefault()
                setOpen(false)
                // 明确表示「不要面板」：本轮聚焦里不再自动弹，只能靠再点一下 / 再输一个字叫回来
                setUserActive(false)
                break
            }
        }
    }

    return (
        <div
            ref={rootRef}
            className={`searchbox no-draggable${concealed && idle ? ' is-concealed' : ''}${composing ? ' is-composing' : ''}`}
        >
            <input
                ref={inputRef}
                className="searchbox-input"
                type="text"
                value={value}
                placeholder="搜索歌曲、歌手、专辑"
                autoComplete="off"
                spellCheck={false}
                role="combobox"
                aria-label="搜索歌曲、歌手、专辑"
                aria-expanded={open}
                aria-autocomplete="list"
                aria-controls={mounted ? LISTBOX_ID : undefined}
                aria-activedescendant={
                    mounted && activeIndex >= 0 ? optionId(activeIndex) : undefined
                }
                onChange={(e) => {
                    setValue(e.target.value)
                    // 打字也是「用户意图」：Tab 进来后一开始输入，就该有建议
                    setUserActive(true)
                }}
                onKeyDown={onKeyDown}
                onKeyUp={syncCursor}
                onClick={syncCursor}
                onSelect={syncCursor}
                onScroll={syncPreviewScroll}
                // 鼠标按下 = 本轮「用户意图」的来源（早于 focus 触发）。
                onMouseDown={() => {
                    setUserActive(true)
                    // 已有缓存分组时先即时展开，随后由拉取结果覆盖（避免等待网络的空白期）
                    if (groups.length > 0) setOpen(true)
                }}
                onFocus={() => {
                    setFocused(true)
                    syncCursor()
                }}
                onBlur={() => {
                    setFocused(false)
                    setUserActive(false)
                }}
                onCompositionStart={() => setComposing(true)}
                onCompositionEnd={() => {
                    setComposing(false)
                    syncCursor()
                }}
            />
            {/* 文本预览层：非合成态下是输入框文字唯一的可视来源（input 文字透明、只留光标）。
                已输入部分与匹配预览后缀在同一文本流里渲染，不存在「文字在两个元素间转移」，
                因此显隐匹配预览时不会跳动。 */}
            <span className="searchbox-preview" aria-hidden="true">
                <span className="searchbox-preview-inner" ref={previewRef}>
                    <span className="searchbox-preview-typed">{value}</span>
                    <span className="searchbox-preview-ghost">{ghostSuffix}</span>
                </span>
            </span>

            {mounted &&
                createPortal(
                    <div
                        ref={panelRef}
                        className={`searchbox-panel${shown ? ' is-open' : ''}`}
                        style={{
                            top: panelPos.top,
                            left: panelPos.left,
                            width: panelPos.width,
                            // 0 表示尚未量出内容高度：先用 auto 让内容自然铺开以供测量
                            height: panelHeight || 'auto',
                        }}
                    >
                        <ScrollArea
                            className="searchbox-scroll-wrap"
                            scrollClassName="searchbox-scroll"
                            thumbClassName="searchbox-scroll-thumb"
                            trigger="hover"
                            autoHide
                            hideDelay={800}
                            deps={[groups, panelHeight]}
                            scrollRef={scrollViewRef}
                        >
                            <div className="searchbox-list" ref={listRef} role="listbox" id={LISTBOX_ID} aria-label="搜索建议">
                                {groups.map((g) => (
                                    <div className="searchbox-group" key={g.key} role="group" aria-label={g.title}>
                                        <div className="searchbox-group-title" aria-hidden="true">{g.title}</div>
                                        {g.items.map((s) => {
                                            const idx = flat.indexOf(s)
                                            const active = idx === activeIndex
                                            return (
                                                <div
                                                    className={`searchbox-item${active ? ' is-active' : ''}`}
                                                    key={idx}
                                                    id={optionId(idx)}
                                                    role="option"
                                                    aria-selected={active}
                                                    onMouseEnter={() => {
                                                        navByKeyRef.current = false
                                                        setActiveIndex(idx)
                                                    }}
                                                    onMouseDown={(e) => {
                                                        e.preventDefault()
                                                        selectSuggestion(s)
                                                    }}
                                                >
                                                    <span className="searchbox-item-text">{s.text}</span>
                                                    {s.sub && <span className="searchbox-item-sub">{s.sub}</span>}
                                                    {s.source === 'local' && s.sourceName ? (
                                                        <span className="searchbox-item-source">{s.sourceName}</span>
                                                    ) : null}
                                                </div>
                                            )
                                        })}
                                    </div>
                                ))}
                            </div>
                        </ScrollArea>
                    </div>,
                    document.body,
                )}
        </div>
    )
})
