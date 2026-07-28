// 博客页面模块化布局(P12.1 骨架;P12.2 加左栏/宽度/窄屏降级/更多模块类型):
// 列表页与详情页各自把模块放进「上 / 左 / 右 / 下」四个槽位,
// 配置存 settings 表的 blog_layout 键(一个 JSON 字符串,无 schema 改动),随公开博客接口一起下发。
//
// 纯逻辑(默认值/容错解析/增删改排序/宽度计算),前端与 worker 复用,可单测。

export const BLOG_LAYOUT_KEY = 'blog_layout'

/** 槽位:上(全宽) / 左(侧栏) / 右(侧栏) / 下(全宽) */
export type SlotName = 'top' | 'left' | 'right' | 'bottom'
export const SLOTS: SlotName[] = ['top', 'left', 'right', 'bottom']
export const SIDE_SLOTS: SlotName[] = ['left', 'right']
export const SLOT_LABELS: Record<SlotName, string> = { top: '顶部', left: '左侧栏', right: '右侧栏', bottom: '底部' }

/** 页面:博客列表 / 文章详情,两套独立配置 */
export type PageName = 'list' | 'detail'
export const PAGES: PageName[] = ['list', 'detail']
export const PAGE_LABELS: Record<PageName, string> = { list: '列表页', detail: '详情页' }

export type WidgetType = 'hot' | 'about' | 'markdown' | 'recent' | 'tags' | 'links'
export const WIDGET_TYPES: WidgetType[] = ['hot', 'about', 'markdown', 'recent', 'tags', 'links']
export const WIDGET_LABELS: Record<WidgetType, string> = {
  hot: '热榜(日/周/月)',
  about: '关于本站',
  markdown: '自定义内容(Markdown)',
  recent: '最新文章',
  tags: '标签云',
  links: '友情链接',
}

export interface Widget {
  /** 实例 id:同一类型可放多个(如详情页顶部一个热榜、底部再一个) */
  id: string
  type: WidgetType
  /** 标题;空串表示不显示标题栏。热榜自带 tab 头,通常留空 */
  title: string
  enabled: boolean
  /** 各模块自有配置:about/markdown 用 text,recent 用 count,links 用 items(一行一条「名称|URL」) */
  options: Record<string, string>
}

/** 窄屏(<1280px)侧栏模块的去向:并到顶部 / 并到底部 / 干脆不显示 */
export type NarrowMode = 'top' | 'bottom' | 'hide'
export const NARROW_LABELS: Record<NarrowMode, string> = { top: '并到顶部', bottom: '并到底部', hide: '不显示' }

export const MIN_SIDE_WIDTH = 200
export const MAX_SIDE_WIDTH = 420
/** 正文容器最大宽度与列间距,与 BlogPage 的 max-w-[1400px] / gap-7 / px-5 对应 */
export const CONTAINER_MAX = 1400
export const COL_GAP = 28
export const CONTAINER_PAD = 40
/** 正文低于这个宽度就该警告:代码块和表格会开始难看 */
export const CONTENT_WARN_BELOW = 700

export interface PageLayout {
  top: Widget[]
  left: Widget[]
  right: Widget[]
  bottom: Widget[]
  leftWidth: number
  rightWidth: number
  narrow: NarrowMode
}
export type BlogLayout = Record<PageName, PageLayout>

const ABOUT_DEFAULT_TEXT =
  '这里是我的公开笔记精选,由 CFNote 个人知识库发布:笔记在编辑器中一键公开,经敏感信息检查后即刻上线。'

function emptyPage(): PageLayout {
  return { top: [], left: [], right: [], bottom: [], leftWidth: 280, rightWidth: 380, narrow: 'bottom' }
}

/** 默认布局 = 模块化之前的样子:列表页右栏「热榜 + 关于本站」,详情页右栏只有热榜。不配置则页面零变化。 */
export function defaultLayout(): BlogLayout {
  return {
    list: {
      ...emptyPage(),
      right: [
        { id: 'hot', type: 'hot', title: '', enabled: true, options: {} },
        { id: 'about', type: 'about', title: '关于本站', enabled: true, options: { text: ABOUT_DEFAULT_TEXT } },
      ],
    },
    detail: {
      ...emptyPage(),
      right: [{ id: 'hot', type: 'hot', title: '', enabled: true, options: {} }],
    },
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** 夹取到 [min,max];非数字回落 fallback */
export function clampWidth(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.round(Math.min(MAX_SIDE_WIDTH, Math.max(MIN_SIDE_WIDTH, n)))
}

/** 容错解析一个模块;类型不认识或结构不对 → null(整条丢弃,不让坏配置拖垮整页) */
function parseWidget(raw: unknown, seq: number): Widget | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type = str(o.type)
  if (!(WIDGET_TYPES as string[]).includes(type)) return null
  const options: Record<string, string> = {}
  if (o.options && typeof o.options === 'object') {
    for (const [k, v] of Object.entries(o.options as Record<string, unknown>)) {
      if (typeof v === 'string') options[k] = v
    }
  }
  return {
    id: str(o.id) || `${type}-${seq}`,
    type: type as WidgetType,
    title: str(o.title),
    enabled: o.enabled !== false, // 缺省视为启用
    options,
  }
}

function parsePage(raw: unknown): PageLayout {
  const out = emptyPage()
  if (!raw || typeof raw !== 'object') return out
  const o = raw as Record<string, unknown>
  let seq = 0
  for (const slot of SLOTS) {
    const arr = o[slot]
    if (!Array.isArray(arr)) continue
    for (const item of arr) {
      const w = parseWidget(item, seq++)
      if (w) out[slot].push(w)
    }
  }
  out.leftWidth = clampWidth(o.leftWidth, out.leftWidth)
  out.rightWidth = clampWidth(o.rightWidth, out.rightWidth)
  if (o.narrow === 'top' || o.narrow === 'bottom' || o.narrow === 'hide') out.narrow = o.narrow
  return out
}

/**
 * settings 里的字符串 → 布局。空值/坏 JSON/结构不对一律回落默认——
 * 布局是展示层配置,任何情况下都不该让博客页打不开。
 */
export function parseBlogLayout(raw: string | null | undefined): BlogLayout {
  if (!raw || !raw.trim()) return defaultLayout()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return defaultLayout()
  }
  if (!data || typeof data !== 'object') return defaultLayout()
  const o = data as Record<string, unknown>
  // 两个页面都没有可识别内容时视为坏配置,回落默认(而不是给出一个空白页面)
  if (o.list === undefined && o.detail === undefined) return defaultLayout()
  const def = defaultLayout()
  return {
    list: o.list === undefined ? def.list : parsePage(o.list),
    detail: o.detail === undefined ? def.detail : parsePage(o.detail),
  }
}

export function serializeBlogLayout(layout: BlogLayout): string {
  return JSON.stringify(layout)
}

/** 某槽位里启用的模块(渲染用) */
export function enabledWidgets(page: PageLayout, slot: SlotName): Widget[] {
  return page[slot].filter((w) => w.enabled)
}

/** 侧栏是否占位(该侧有启用的模块才占) */
export function hasSide(page: PageLayout, slot: 'left' | 'right'): boolean {
  return enabledWidgets(page, slot).length > 0
}

/**
 * 宽屏(≥1280px 且容器满宽)下正文的实际可用宽度。
 * 配置页据此实时提示,低于 CONTENT_WARN_BELOW 时警告——左右同开最容易踩这个坑。
 */
export function contentWidth(page: PageLayout): number {
  let w = CONTAINER_MAX - CONTAINER_PAD
  if (hasSide(page, 'left')) w -= page.leftWidth + COL_GAP
  if (hasSide(page, 'right')) w -= page.rightWidth + COL_GAP
  return Math.max(0, w)
}

/** 友情链接配置:一行一条「名称|URL」;缺 URL 或 URL 非 http(s)/相对路径的整行丢弃 */
export function parseLinks(text: string | undefined): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = []
  for (const line of (text || '').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const i = t.indexOf('|')
    if (i <= 0) continue
    const name = t.slice(0, i).trim()
    const url = t.slice(i + 1).trim()
    // 只放行 http(s) 与站内相对路径:挡掉 javascript: 一类
    if (!name || !url || !/^(https?:\/\/|\/)/i.test(url)) continue
    out.push({ name, url })
  }
  return out
}

// ---- 配置页用的不可变操作(都返回新对象,不改入参) ----

function mapPage(layout: BlogLayout, page: PageName, fn: (p: PageLayout) => PageLayout): BlogLayout {
  return { ...layout, [page]: fn(layout[page]) }
}

/** 只改模块数组、保留宽度等页面级设置 */
function withSlots(p: PageLayout, fn: (slot: SlotName, list: Widget[]) => Widget[]): PageLayout {
  const out: PageLayout = { ...p, top: [], left: [], right: [], bottom: [] }
  for (const slot of SLOTS) out[slot] = fn(slot, p[slot])
  return out
}

/** 开关某个模块 */
export function toggleWidget(layout: BlogLayout, page: PageName, id: string): BlogLayout {
  return mapPage(layout, page, (p) =>
    withSlots(p, (_s, list) => list.map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w)))
  )
}

/** 改某个模块的字段(标题/选项);id 不可改 */
export function updateWidget(layout: BlogLayout, page: PageName, id: string, patch: Partial<Widget>): BlogLayout {
  return mapPage(layout, page, (p) =>
    withSlots(p, (_s, list) => list.map((w) => (w.id === id ? { ...w, ...patch, id: w.id } : w)))
  )
}

/** 改页面级设置(侧栏宽度、窄屏降级位置) */
export function updatePageSettings(
  layout: BlogLayout,
  page: PageName,
  patch: Partial<Pick<PageLayout, 'leftWidth' | 'rightWidth' | 'narrow'>>
): BlogLayout {
  return mapPage(layout, page, (p) => ({
    ...p,
    leftWidth: patch.leftWidth === undefined ? p.leftWidth : clampWidth(patch.leftWidth, p.leftWidth),
    rightWidth: patch.rightWidth === undefined ? p.rightWidth : clampWidth(patch.rightWidth, p.rightWidth),
    narrow: patch.narrow ?? p.narrow,
  }))
}

/**
 * 把模块移到目标槽位的指定位置。index 越界自动夹到两端;
 * 同槽位内移动时先摘出再插入(所以「下移一位」传原 index+1 即可)。
 */
export function moveWidget(layout: BlogLayout, page: PageName, id: string, toSlot: SlotName, toIndex: number): BlogLayout {
  return mapPage(layout, page, (p) => {
    let moving: Widget | null = null
    const out = withSlots(p, (_s, list) =>
      list.filter((w) => {
        if (w.id !== id) return true
        moving = w
        return false
      })
    )
    if (!moving) return p
    const idx = Math.max(0, Math.min(toIndex, out[toSlot].length))
    out[toSlot].splice(idx, 0, moving)
    return out
  })
}

/** 当前所在槽位与下标(配置页算上/下移目标用);找不到返回 null */
export function locateWidget(page: PageLayout, id: string): { slot: SlotName; index: number } | null {
  for (const slot of SLOTS) {
    const index = page[slot].findIndex((w) => w.id === id)
    if (index >= 0) return { slot, index }
  }
  return null
}

/** 新模块的初始配置 */
function newWidget(id: string, type: WidgetType): Widget {
  const base: Widget = { id, type, title: '', enabled: true, options: {} }
  switch (type) {
    case 'about':
      return { ...base, title: '关于本站', options: { text: ABOUT_DEFAULT_TEXT } }
    case 'markdown':
      return { ...base, title: '自定义内容', options: { text: '支持 **Markdown**:标题、列表、链接、图片、代码块都能用。' } }
    case 'recent':
      return { ...base, title: '最新文章', options: { count: '8' } }
    case 'tags':
      return { ...base, title: '标签' }
    case 'links':
      return { ...base, title: '友情链接', options: { items: 'Cloudflare|https://www.cloudflare.com' } }
    default:
      return base
  }
}

/** 新增一个模块到槽位末尾;id 用「类型-序号」保证同页唯一 */
export function addWidget(layout: BlogLayout, page: PageName, slot: SlotName, type: WidgetType): BlogLayout {
  const used = new Set<string>()
  for (const s of SLOTS) for (const w of layout[page][s]) used.add(w.id)
  let n = 1
  let id: string = type
  while (used.has(id)) id = `${type}-${++n}`
  return mapPage(layout, page, (p) => ({ ...p, [slot]: [...p[slot], newWidget(id, type)] }))
}

/** 删除模块 */
export function removeWidget(layout: BlogLayout, page: PageName, id: string): BlogLayout {
  return mapPage(layout, page, (p) => withSlots(p, (_s, list) => list.filter((w) => w.id !== id)))
}
