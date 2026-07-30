// 文章块部件(P12.8):详情页正文区由哪些部分、按什么顺序组成。
//
// P12.1–12.4 的模块系统管的是**文章周围**(顶部/左栏/右栏/底部四个槽位),文章块本身一直是写死的:
// 面包屑 → 标题 → 元信息行 → 正文 → 「· 完 ·」→ 评论。这是 WordPress 的 single.php 能干而我们干不了的事。
//
// 这里刻意**不做模板语言**:那会让「服务端预渲染」与「客户端 React」变成两个模板引擎,必然走样
// (P12.6 拒绝预渲染那 12 种模块用的是同一个理由)。部件是一份声明式的有限清单,
// 两边各自照着它渲染,预渲染那侧只需改 articleBlockHtml 一个函数。

export type ArticlePartType =
  | 'breadcrumb'
  | 'title'
  | 'meta'
  | 'content'
  | 'tags'
  | 'divider'
  | 'copyright'
  | 'comments'

export interface ArticlePart {
  type: ArticlePartType
  enabled: boolean
  options: Record<string, string>
}

export const ARTICLE_PART_LABELS: Record<ArticlePartType, string> = {
  breadcrumb: '面包屑',
  title: '标题',
  meta: '元信息行',
  content: '正文',
  tags: '标签行',
  divider: '结束标记',
  copyright: '版权声明',
  comments: '评论区',
}

export const ARTICLE_PART_HINTS: Record<ArticlePartType, string> = {
  breadcrumb: '「首页 > 笔记本名」,可点跳转',
  title: '文章大标题(页面唯一的 h1,关掉会影响搜索引擎理解页面)',
  meta: '时间 / 来源 / Tags / 浏览数,各自可开关',
  content: '文章正文,不可停用',
  tags: '独立成行的标签,常放在正文之后',
  divider: '正文结束的收尾符号',
  copyright: '自定义文本,按 Markdown 渲染(与自定义 Markdown 模块同一条路径)',
  comments: '位置可调;要彻底关闭评论请用「设置 → 评论」',
}

/**
 * 不可停用的部件。
 * 正文不用解释;评论区之所以只能移动不能停用,是因为它的开关已经在「设置 → 评论」里了
 * (那个开关同时会让 POST 返回 403)。同一件事有两个开关,迟早会出现「这里关了那里还能提交」的困惑。
 *
 * 单页(P13.4)是这条规矩的唯一例外:「公告」「关于我」下面挂一串评论是不对的,而全局开关
 * 仍然是唯一决定「能不能提交」的地方——单页这个只是不渲染评论区,不会出现「这里关了那里还能提交」。
 */
export type PartScope = 'post' | 'page'

export const LOCKED_ARTICLE_PARTS: ArticlePartType[] = ['content', 'comments']
const LOCKED_PAGE_PARTS: ArticlePartType[] = ['content']

export function lockedParts(scope: PartScope = 'post'): ArticlePartType[] {
  return scope === 'page' ? LOCKED_PAGE_PARTS : LOCKED_ARTICLE_PARTS
}

export function isPartLocked(t: ArticlePartType, scope: PartScope = 'post'): boolean {
  return lockedParts(scope).includes(t)
}

export const DEFAULT_SOURCE_TEXT = '来源：CFNote 笔记'
export const DEFAULT_DIVIDER_TEXT = '· 完 ·'
export const MAX_PART_TEXT = 2000

/** 默认部件表 = 改造前的详情页,逐项一致(标签行与版权声明默认关闭,不配置则页面零变化) */
export function defaultArticleParts(): ArticlePart[] {
  return [
    { type: 'breadcrumb', enabled: true, options: {} },
    { type: 'title', enabled: true, options: {} },
    {
      type: 'meta',
      enabled: true,
      options: { time: '1', source: '1', sourceText: DEFAULT_SOURCE_TEXT, tags: '1', views: '1' },
    },
    { type: 'content', enabled: true, options: {} },
    { type: 'tags', enabled: false, options: {} },
    { type: 'divider', enabled: true, options: { text: DEFAULT_DIVIDER_TEXT } },
    { type: 'copyright', enabled: false, options: { text: '' } },
    { type: 'comments', enabled: true, options: {} },
  ]
}

const ALL_TYPES = defaultArticleParts().map((p) => p.type)

/**
 * 单页的默认部件表(P13.4):只留标题与正文,其余全关。
 * 这正是单页存在的理由——「关于我」不该有面包屑、发布时间、浏览数和「来源:CFNote 笔记」。
 * 顺序与文章保持一致,这样在两个页签之间来回看时心智模型是同一个。
 */
export function defaultPageArticleParts(): ArticlePart[] {
  return defaultArticleParts().map((p) => ({
    ...p,
    enabled: p.type === 'title' || p.type === 'content',
    options: { ...p.options },
  }))
}

function isPartType(v: unknown): v is ArticlePartType {
  return typeof v === 'string' && (ALL_TYPES as string[]).includes(v)
}

function parseOptions(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val.slice(0, MAX_PART_TEXT)
  }
  return out
}

/**
 * 解析。成员是**固定的**:未知类型丢弃、重复只留第一个、缺失的补上默认值。
 * 也就是说这份配置只能排序与开关,不能增删——这样「详情页由这几块组成」是个恒定的心智模型,
 * 也省掉了「配置里没有正文怎么办」这类边界。
 *
 * 补齐的部件追加在末尾:将来若新增第 9 种部件,老配置里它会落在最下面,可能需要手动挪一下位置。
 */
export function parseArticleParts(v: unknown, scope: PartScope = 'post'): ArticlePart[] {
  const def = scope === 'page' ? defaultPageArticleParts() : defaultArticleParts()
  if (!Array.isArray(v)) return def
  const byType = new Map(def.map((p) => [p.type, p]))
  const out: ArticlePart[] = []
  const seen = new Set<ArticlePartType>()
  for (const item of v) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (!isPartType(o.type) || seen.has(o.type)) continue
    seen.add(o.type)
    const fallback = byType.get(o.type)!
    out.push({
      type: o.type,
      // 锁定的部件无论配置写什么都必须启用
      enabled: isPartLocked(o.type, scope) ? true : o.enabled !== false,
      options: { ...fallback.options, ...parseOptions(o.options) },
    })
  }
  for (const p of def) if (!seen.has(p.type)) out.push(p)
  return out
}

// ---- 读取 ----

/** options 里的布尔:'0' 为关,其余(含缺省)为开 */
export function partFlag(part: ArticlePart | undefined, key: string, def = true): boolean {
  if (!part) return def
  const v = part.options?.[key]
  return v === undefined ? def : v !== '0'
}

export function findPart(parts: ArticlePart[], type: ArticlePartType): ArticlePart | undefined {
  return parts.find((p) => p.type === type)
}

export function articlePartOption(parts: ArticlePart[], type: ArticlePartType, key: string, fallback: string): string {
  const v = findPart(parts, type)?.options?.[key]
  return typeof v === 'string' && v !== '' ? v : fallback
}

/** 渲染用:按配置顺序,只留启用的 */
export function enabledArticleParts(parts: ArticlePart[]): ArticlePart[] {
  return parts.filter((p) => p.enabled)
}

// ---- 编辑(纯函数,便于单测)----

export function moveArticlePart(parts: ArticlePart[], type: ArticlePartType, delta: number): ArticlePart[] {
  const i = parts.findIndex((p) => p.type === type)
  const to = i + delta
  if (i < 0 || to < 0 || to >= parts.length) return parts
  const next = [...parts]
  const [item] = next.splice(i, 1)
  next.splice(to, 0, item)
  return next
}

export function toggleArticlePart(
  parts: ArticlePart[],
  type: ArticlePartType,
  enabled: boolean,
  scope: PartScope = 'post'
): ArticlePart[] {
  if (isPartLocked(type, scope)) return parts
  return parts.map((p) => (p.type === type ? { ...p, enabled } : p))
}

export function setArticlePartOption(
  parts: ArticlePart[],
  type: ArticlePartType,
  key: string,
  value: string
): ArticlePart[] {
  return parts.map((p) =>
    p.type === type ? { ...p, options: { ...p.options, [key]: value.slice(0, MAX_PART_TEXT) } } : p
  )
}
