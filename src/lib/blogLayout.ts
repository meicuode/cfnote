// 博客页面模块化布局(P12.1 骨架;P12.2 加左栏/宽度/窄屏降级/更多模块类型):
// 列表页与详情页各自把模块放进「上 / 左 / 右 / 下」四个槽位,
// 配置存 settings 表的 blog_layout 键(一个 JSON 字符串,无 schema 改动),随公开博客接口一起下发。
//
// 纯逻辑(默认值/容错解析/增删改排序/宽度计算),前端与 worker 复用,可单测。

import { defaultArticleParts, defaultPageArticleParts, parseArticleParts, type ArticlePart } from './blogArticleParts'

export const BLOG_LAYOUT_KEY = 'blog_layout'

/** 槽位:上(全宽) / 左(侧栏) / 右(侧栏) / 下(全宽) */
export type SlotName = 'top' | 'left' | 'right' | 'bottom'
export const SLOTS: SlotName[] = ['top', 'left', 'right', 'bottom']
export const SIDE_SLOTS: SlotName[] = ['left', 'right']
export const SLOT_LABELS: Record<SlotName, string> = { top: '顶部', left: '左侧栏', right: '右侧栏', bottom: '底部' }

/** 页面:博客列表 / 文章详情,两套独立配置 */
export type PageName = 'list' | 'detail' | 'page'
export const PAGES: PageName[] = ['list', 'detail', 'page']
export const PAGE_LABELS: Record<PageName, string> = { list: '列表页', detail: '详情页', page: '单页' }

export type WidgetType =
  | 'hot' | 'about' | 'markdown' | 'recent' | 'tags' | 'links' | 'search'
  // P12.4 顶部/底部向的模块(对标 WordPress 主题的 header/footer 组件)
  | 'slider' | 'banner' | 'prevnext' | 'related' | 'postgrid'
export const WIDGET_TYPES: WidgetType[] = [
  'hot', 'about', 'markdown', 'recent', 'tags', 'links', 'search',
  'slider', 'banner', 'prevnext', 'related', 'postgrid',
]
export const WIDGET_LABELS: Record<WidgetType, string> = {
  hot: '热榜(日/周/月)',
  about: '关于本站',
  markdown: '自定义内容(Markdown)',
  recent: '最新文章',
  tags: '标签云',
  links: '友情链接',
  search: '站内搜索',
  slider: '幻灯片 / 焦点图',
  banner: '站点横幅',
  prevnext: '上一篇 / 下一篇',
  related: '相关文章',
  postgrid: '文章宫格',
}

/**
 * 各模块「适合放哪个槽位」。不做硬性禁止(宽度都是自适应的,硬禁反而让人困惑,
 * WordPress 也只是给主题划出小工具区而已),只在添加菜单里分「常用 / 其他」两组。
 */
export const WIDGET_SLOT_HINT: Record<WidgetType, SlotName[]> = {
  hot: ['left', 'right'],
  about: ['left', 'right'],
  markdown: ['top', 'left', 'right', 'bottom'],
  recent: ['left', 'right'],
  tags: ['left', 'right'],
  links: ['left', 'right'],
  search: ['top', 'left', 'right'],
  slider: ['top'],
  banner: ['top'],
  prevnext: ['bottom'],
  related: ['bottom'],
  postgrid: ['top', 'bottom'],
}

/**
 * 只有详情页才有「当前文章」,这两个模块在列表页无从谈起。
 * 单页(P13.4)同样不算:单页不在文章流里,「上一篇/下一篇」和「相关文章」对它没有定义
 * (loadBlogDetail 也刻意不给单页传 seed)。
 */
export const DETAIL_ONLY_WIDGETS: WidgetType[] = ['prevnext', 'related']

export function widgetWorksOn(type: WidgetType, page: PageName): boolean {
  return page === 'detail' || !DETAIL_ONLY_WIDGETS.includes(type)
}

/** 添加菜单分组:该槽位常用的排前面 */
export function widgetChoices(slot: SlotName, page: PageName): { common: WidgetType[]; others: WidgetType[] } {
  const usable = WIDGET_TYPES.filter((t) => widgetWorksOn(t, page))
  return {
    common: usable.filter((t) => WIDGET_SLOT_HINT[t].includes(slot)),
    others: usable.filter((t) => !WIDGET_SLOT_HINT[t].includes(slot)),
  }
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

// ---- 导航菜单(P12.3)----
// 对应 WordPress 的「外观 → 菜单」。跟着 blog_layout 一起存/一起下发,
// 不另开 settings 键:每多一个键就是博客接口里多一次 D1 查询。

export type MenuItemType = 'home' | 'tag' | 'page' | 'link'
export const MENU_ITEM_TYPES: MenuItemType[] = ['home', 'tag', 'page', 'link']
export const MENU_TYPE_LABELS: Record<MenuItemType, string> = {
  home: '首页',
  tag: '标签 / 笔记本',
  page: '单页(某篇公开笔记)',
  link: '外部链接',
}
/** 各类型的「值」填什么:配置页当 placeholder 用 */
export const MENU_VALUE_HINTS: Record<MenuItemType, string> = {
  home: '无需填写',
  tag: '标签名或笔记本名,如「运维」',
  page: '文章 id,如 12(在博客里打开该文即可从地址栏看到)',
  link: 'https://example.com 或站内 /clip',
}

export interface MenuItem {
  id: string
  type: MenuItemType
  /** 显示文字;留空则回落成类型默认名 */
  label: string
  /** tag=标签名 / page=文章 id / link=URL;home 不用 */
  value: string
}

export interface BlogLayout {
  list: PageLayout
  detail: PageLayout
  /** 单页(P13.4)的槽位。与详情页分开:「关于我」通常不要热榜侧栏、不要相关文章 */
  page: PageLayout
  menu: MenuItem[]
  /** 详情页正文区的部件与顺序(P12.8)。跟着布局走,不单开 settings 键——每多一个键就是每次博客请求多一趟 D1 */
  article: ArticlePart[]
  /** 单页正文区的部件与顺序(P13.4)。默认只留标题 + 正文——单页要的正是「没有元信息」 */
  pageArticle: ArticlePart[]
}

const ABOUT_DEFAULT_TEXT =
  '这里是我的公开笔记精选,由 CFNote 个人知识库发布:笔记在编辑器中一键公开,经敏感信息检查后即刻上线。'

function emptyPage(): PageLayout {
  return { top: [], left: [], right: [], bottom: [], leftWidth: 280, rightWidth: 380, narrow: 'bottom' }
}

/** 默认菜单 = 改造前的样子:只有一个「首页」 */
export function defaultMenu(): MenuItem[] {
  return [{ id: 'home', type: 'home', label: '首页', value: '' }]
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
    // 单页默认干干净净:没有侧栏模块。要挂什么由博主自己加
    page: emptyPage(),
    menu: defaultMenu(),
    article: defaultArticleParts(),
    pageArticle: defaultPageArticleParts(),
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

/** 容错解析菜单;单项类型不认识就整条丢弃(与模块同策略) */
function parseMenu(raw: unknown): MenuItem[] {
  if (!Array.isArray(raw)) return defaultMenu()
  const out: MenuItem[] = []
  let seq = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const type = str(o.type)
    if (!(MENU_ITEM_TYPES as string[]).includes(type)) continue
    const t = type as MenuItemType
    out.push({
      id: str(o.id) || `${t}-${seq++}`,
      type: t,
      label: str(o.label) || MENU_TYPE_LABELS[t],
      value: str(o.value),
    })
  }
  return out
}

/**
 * 菜单项 → 链接。返回 null 表示这条配置不可用(前端直接跳过不渲染)。
 * 外链只放行 http(s) 与站内 / 开头的路径,与友情链接同一把尺子(挡 javascript: 一类)。
 */
export function menuHref(item: MenuItem): string | null {
  switch (item.type) {
    case 'home':
      return '/blog'
    case 'tag':
      return item.value.trim() ? `/blog?tag=${encodeURIComponent(item.value.trim())}` : null
    case 'page': {
      // 不带 slug(P15.2):菜单项的 value 是**手填的文章 id**,这里根本没有标题可算。
      // 站内其他地方都发规范地址,只有这一条是裸 id——而它照常打得开(slug 纯属装饰),
      // 代价仅仅是地址栏不好看。要修就得让配置页存一份 slug,不值当。
      const n = Number(item.value)
      return Number.isInteger(n) && n > 0 ? `/blog/${n}` : null
    }
    case 'link': {
      const url = item.value.trim()
      return url && /^(https?:\/\/|\/)/i.test(url) ? url : null
    }
    default:
      return null
  }
}

/** 能渲染出来的菜单项(配置不完整的直接不显示,而不是给个死链) */
export function usableMenu(menu: MenuItem[]): { item: MenuItem; href: string }[] {
  const out: { item: MenuItem; href: string }[] = []
  for (const item of menu || []) {
    const href = menuHref(item)
    if (href) out.push({ item, href })
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
  // 几部分都没有可识别内容时视为坏配置,回落默认(而不是给出一个空白页面)
  if (o.list === undefined && o.detail === undefined && o.menu === undefined && o.article === undefined) {
    return defaultLayout()
  }
  const def = defaultLayout()
  return {
    list: o.list === undefined ? def.list : parsePage(o.list),
    detail: o.detail === undefined ? def.detail : parsePage(o.detail),
    // page / pageArticle 是 P13.4 才有的,老配置里没有 → 补默认值(而不是渲染出空白单页)
    page: o.page === undefined ? def.page : parsePage(o.page),
    menu: o.menu === undefined ? def.menu : parseMenu(o.menu),
    article: o.article === undefined ? def.article : parseArticleParts(o.article),
    pageArticle: o.pageArticle === undefined ? def.pageArticle : parseArticleParts(o.pageArticle, 'page'),
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
 * 该页面是否启用了某类模块。worker 据此决定随响应下发哪几份数据
 * (热榜/最新文章/标签云),没用到的一行都不查——「一个页面一次请求」的前提。
 */
export function pageUsesWidget(page: PageLayout, type: WidgetType): boolean {
  return SLOTS.some((s) => page[s].some((w) => w.enabled && w.type === type))
}

/** 该页面所有启用模块里,某个数值选项的最大值(如「最新文章」放了两个,取条数大的那个) */
export function maxWidgetOption(page: PageLayout, type: WidgetType, key: string, fallback: number): number {
  let out = 0
  for (const s of SLOTS) {
    for (const w of page[s]) {
      if (!w.enabled || w.type !== type) continue
      const n = Number(w.options[key])
      if (Number.isFinite(n)) out = Math.max(out, n)
    }
  }
  return out > 0 ? out : fallback
}

/**
 * 该页面第一个启用的该类模块的某个文本选项(如幻灯片的取数来源)。
 * 同一页放两个来源不同的幻灯片属于极端用法,按第一个取——多查一份数据不值当。
 */
export function firstWidgetOption(page: PageLayout, type: WidgetType, key: string, fallback: string): string {
  for (const s of SLOTS) {
    for (const w of page[s]) {
      if (w.enabled && w.type === type && w.options[key]) return w.options[key]
    }
  }
  return fallback
}

/**
 * 宽屏(≥1280px 且容器满宽)下正文的实际可用宽度。
 * 配置页据此实时提示,低于 CONTENT_WARN_BELOW 时警告——左右同开最容易踩这个坑。
 * containerMax 可传皮肤里配的容器宽度(P12.5 起可调),不传则用默认的 1400。
 */
export function contentWidth(page: PageLayout, containerMax = CONTAINER_MAX): number {
  let w = containerMax - CONTAINER_PAD
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

/** 站点横幅的背景配置:图片 URL / 纯色 / 未配置。只放行安全形态,挡掉 `url(javascript:…)` 一类 */
export function parseBannerBg(bg: string | undefined): { kind: 'image' | 'color' | 'none'; value: string } {
  const v = (bg || '').trim()
  if (!v) return { kind: 'none', value: '' }
  if (/^(https?:\/\/|\/)[^\s"')]*$/i.test(v)) return { kind: 'image', value: v }
  // 颜色只认 #hex 与 rgb()/rgba()/hsl()/hsla(),其余(含任意 CSS 函数)一律回落成默认背景
  if (/^#[0-9a-f]{3,8}$/i.test(v) || /^(rgb|hsl)a?\([\d\s.,%/-]+\)$/i.test(v)) return { kind: 'color', value: v }
  return { kind: 'none', value: '' }
}

// ---- 配置页用的不可变操作(都返回新对象,不改入参) ----

function mapPage(layout: BlogLayout, page: PageName, fn: (p: PageLayout) => PageLayout): BlogLayout {
  // 写成分支而不是 { ...layout, [page]: ... }:计算属性名会把类型擦成索引签名,接口化后过不了 tsc
  return page === 'list' ? { ...layout, list: fn(layout.list) } : { ...layout, detail: fn(layout.detail) }
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

/** 新模块的初始配置;slot 只有少数模块用得上(幻灯片按槽位选默认形态) */
function newWidget(id: string, type: WidgetType, slot: SlotName): Widget {
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
    case 'search':
      return { ...base, title: '', options: { placeholder: '搜索文章…' } }
    case 'slider':
      // 默认 5 张、自动播放 5 秒。首图 eager 其余 lazy,且只渲染当前 ±1 张——
      // 幻灯片是这批模块里唯一有真实带宽成本的,默认值要保守。
      // 形态(P13.2)按槽位选:顶部/底部是通栏,单图铺满会被拉得又宽又扁,故默认「主图 + 侧栏标题」;
      // 侧栏那种窄容器仍然是单图最合适。已有配置没有 variant 字段 → 渲染时回落 single,行为不变。
      return {
        ...base,
        title: '',
        options: {
          source: 'recent', count: '5', auto: '1', interval: '5', height: 'md',
          variant: slot === 'left' || slot === 'right' ? 'single' : 'spotlight',
        },
      }
    case 'banner':
      // 「可关闭 + 小高度」就是公告条,故不再单列一个公告条模块
      return {
        ...base,
        title: '',
        options: { heading: '欢迎来到我的博客', subtitle: '这里是我的公开笔记精选。', bg: '', btnText: '', btnUrl: '', height: 'md', dismissible: '0' },
      }
    case 'prevnext':
      return { ...base, title: '' }
    case 'related':
      return { ...base, title: '相关文章', options: { count: '4' } }
    case 'postgrid':
      return { ...base, title: '推荐阅读', options: { source: 'recent', count: '6', cols: '3' } }
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
  return mapPage(layout, page, (p) => ({ ...p, [slot]: [...p[slot], newWidget(id, type, slot)] }))
}

/** 删除模块 */
export function removeWidget(layout: BlogLayout, page: PageName, id: string): BlogLayout {
  return mapPage(layout, page, (p) => withSlots(p, (_s, list) => list.filter((w) => w.id !== id)))
}

// ---- 导航菜单的不可变操作(P12.3)----

function newMenuItem(id: string, type: MenuItemType): MenuItem {
  return { id, type, label: MENU_TYPE_LABELS[type], value: '' }
}

/** 追加一个菜单项;id 用「类型-序号」保证唯一 */
export function addMenuItem(layout: BlogLayout, type: MenuItemType): BlogLayout {
  const used = new Set(layout.menu.map((m) => m.id))
  let n = 1
  let id: string = type
  while (used.has(id)) id = `${type}-${++n}`
  return { ...layout, menu: [...layout.menu, newMenuItem(id, type)] }
}

export function updateMenuItem(layout: BlogLayout, id: string, patch: Partial<MenuItem>): BlogLayout {
  return { ...layout, menu: layout.menu.map((m) => (m.id === id ? { ...m, ...patch, id: m.id } : m)) }
}

export function removeMenuItem(layout: BlogLayout, id: string): BlogLayout {
  return { ...layout, menu: layout.menu.filter((m) => m.id !== id) }
}

/** 菜单项换序;越界原样返回 */
export function moveMenuItem(layout: BlogLayout, id: string, delta: number): BlogLayout {
  const i = layout.menu.findIndex((m) => m.id === id)
  if (i < 0) return layout
  const to = i + delta
  if (to < 0 || to >= layout.menu.length) return layout
  const menu = [...layout.menu]
  const [item] = menu.splice(i, 1)
  menu.splice(to, 0, item)
  return { ...layout, menu }
}
