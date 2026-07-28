// 博客页面模块化布局(P12.1):列表页与详情页各自把模块放进「上 / 右 / 下」三个槽位,
// 配置存 settings 表的 blog_layout 键(一个 JSON 字符串,无 schema 改动),随公开博客接口一起下发。
//
// 左栏留给 P12.2:容器是 max-w-[1400px],右栏 380px 时正文已只剩约 950px,
// 再切一列左栏正文会压到 ~560px,得先把「侧栏宽度可配 + 窄屏降级位置」做出来才敢开。
//
// 纯逻辑(默认值/容错解析/增删改排序),前端与 worker 复用,可单测。

export const BLOG_LAYOUT_KEY = 'blog_layout'

/** 槽位:上(全宽) / 右(侧栏) / 下(全宽) */
export type SlotName = 'top' | 'right' | 'bottom'
export const SLOTS: SlotName[] = ['top', 'right', 'bottom']
export const SLOT_LABELS: Record<SlotName, string> = { top: '顶部', right: '右侧栏', bottom: '底部' }

/** 页面:博客列表 / 文章详情,两套独立配置 */
export type PageName = 'list' | 'detail'
export const PAGES: PageName[] = ['list', 'detail']
export const PAGE_LABELS: Record<PageName, string> = { list: '列表页', detail: '详情页' }

/** 模块类型(P12.1 只做已有的两个;自定义 Markdown 等在 P12.2) */
export type WidgetType = 'hot' | 'about'
export const WIDGET_TYPES: WidgetType[] = ['hot', 'about']
export const WIDGET_LABELS: Record<WidgetType, string> = { hot: '热榜(日/周/月)', about: '关于本站' }

export interface Widget {
  /** 实例 id:同一类型可放多个(如详情页顶部一个热榜、底部再一个) */
  id: string
  type: WidgetType
  /** 标题;空串表示不显示标题栏。热榜自带 tab 头,忽略此项 */
  title: string
  enabled: boolean
  /** 各模块自有配置(about 的正文等);P12.1 只用到 text */
  options: Record<string, string>
}

export type PageLayout = Record<SlotName, Widget[]>
export type BlogLayout = Record<PageName, PageLayout>

const ABOUT_DEFAULT_TEXT =
  '这里是我的公开笔记精选,由 CFNote 个人知识库发布:笔记在编辑器中一键公开,经敏感信息检查后即刻上线。'

/** 默认布局 = P12.1 之前的样子:列表页右栏「热榜 + 关于本站」,详情页右栏只有热榜。不配置则页面零变化。 */
export function defaultLayout(): BlogLayout {
  return {
    list: {
      top: [],
      right: [
        { id: 'hot', type: 'hot', title: '', enabled: true, options: {} },
        { id: 'about', type: 'about', title: '关于本站', enabled: true, options: { text: ABOUT_DEFAULT_TEXT } },
      ],
      bottom: [],
    },
    detail: {
      top: [],
      right: [{ id: 'hot', type: 'hot', title: '', enabled: true, options: {} }],
      bottom: [],
    },
  }
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
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
  const out: PageLayout = { top: [], right: [], bottom: [] }
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

// ---- 配置页用的不可变操作(都返回新对象,不改入参) ----

function mapPage(layout: BlogLayout, page: PageName, fn: (p: PageLayout) => PageLayout): BlogLayout {
  return { ...layout, [page]: fn(layout[page]) }
}

/** 开关某个模块 */
export function toggleWidget(layout: BlogLayout, page: PageName, id: string): BlogLayout {
  return mapPage(layout, page, (p) => {
    const out: PageLayout = { top: [], right: [], bottom: [] }
    for (const slot of SLOTS) out[slot] = p[slot].map((w) => (w.id === id ? { ...w, enabled: !w.enabled } : w))
    return out
  })
}

/** 改某个模块的字段(标题/选项) */
export function updateWidget(layout: BlogLayout, page: PageName, id: string, patch: Partial<Widget>): BlogLayout {
  return mapPage(layout, page, (p) => {
    const out: PageLayout = { top: [], right: [], bottom: [] }
    for (const slot of SLOTS) out[slot] = p[slot].map((w) => (w.id === id ? { ...w, ...patch, id: w.id } : w))
    return out
  })
}

/**
 * 把模块移到目标槽位的指定位置。index 越界自动夹到两端;
 * 同槽位内移动时先摘出再插入(所以「下移一位」传原 index+1 即可)。
 */
export function moveWidget(layout: BlogLayout, page: PageName, id: string, toSlot: SlotName, toIndex: number): BlogLayout {
  return mapPage(layout, page, (p) => {
    let moving: Widget | null = null
    const out: PageLayout = { top: [], right: [], bottom: [] }
    for (const slot of SLOTS) {
      out[slot] = p[slot].filter((w) => {
        if (w.id !== id) return true
        moving = w
        return false
      })
    }
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

/** 新增一个模块到槽位末尾;id 用「类型-序号」保证同页唯一 */
export function addWidget(layout: BlogLayout, page: PageName, slot: SlotName, type: WidgetType): BlogLayout {
  const used = new Set<string>()
  for (const s of SLOTS) for (const w of layout[page][s]) used.add(w.id)
  let n = 1
  let id: string = type
  while (used.has(id)) id = `${type}-${++n}`
  const w: Widget = {
    id,
    type,
    title: type === 'about' ? '关于本站' : '',
    enabled: true,
    options: type === 'about' ? { text: ABOUT_DEFAULT_TEXT } : {},
  }
  return mapPage(layout, page, (p) => ({ ...p, [slot]: [...p[slot], w] }))
}

/** 删除模块 */
export function removeWidget(layout: BlogLayout, page: PageName, id: string): BlogLayout {
  return mapPage(layout, page, (p) => {
    const out: PageLayout = { top: [], right: [], bottom: [] }
    for (const slot of SLOTS) out[slot] = p[slot].filter((w) => w.id !== id)
    return out
  })
}
