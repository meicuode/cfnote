import { getSettingValues } from '../utils'
import { mdExcerpt, mdFirstImage } from '../../src/lib/blogExtract'
import { parseTags } from '../../src/types'
import type { FlatComment } from '../../src/lib/comments'
import {
  parseBlogLayout, pageUsesWidget, maxWidgetOption, firstWidgetOption, BLOG_LAYOUT_KEY, type PageLayout,
} from '../../src/lib/blogLayout'
import { parseBlogSkin, BLOG_SKIN_KEY } from '../../src/lib/blogSkin'
import { CUSTOM_JS_KEY, MAX_CUSTOM_JS } from '../../src/lib/blogScripts'
import { tagLikePattern, textLikePattern, buildTagCloud, scoreRelated } from '../../src/lib/blogQuery'
import type { AppEnv } from '../types'

/**
 * 公开博客的取数层(P13.5)。
 *
 * 为什么单独一个文件:本项目的两条安全不变量——「哪些文章能被公开读到」与「哪些列能进公开响应」
 * ——原先散在 blog.ts 十来个查询点上。加一个模块(P12.4 那批五个)或加一条筛选(P13.4 的单页)
 * 就要把同一个 WHERE 抄一遍,抄漏一次就是把未公开的文章漏出去。收拢到这里之后,
 * blog.ts 与 pages.ts 只调函数、不见 SQL,改不变量只有一处可改。
 *
 * 这不是完整的 repository 层,也刻意不做成那样:仓库里没有 D1 的测试替身,
 * 把全部路由的 SQL 都搬一遍不会让它们变得可测,只会多一层间接。
 * 覆盖它们的是 tests/worker/*(真 workerd + 真 D1,见 DESIGN.md §11.1)。
 *
 * 边界:这里只有取数与「行 → 公开响应字段」的映射。
 * 请求解析、鉴权、浏览计数去重(Cache API)、评论限流与线程装配仍在 blog.ts。
 */

type Env = AppEnv['Bindings']

// 只读列表的公共 WHERE(所有公开查询共用同一把尺子,避免哪天漏掉一个条件把私有文章漏出去)
const PUBLIC_WHERE = 'a.is_public = 1 AND a.is_private = 0 AND a.deleted_at IS NULL'

// 单页(P13.4)在「可公开访问」这件事上与文章完全一样,区别只在**不进 loop**:
// 列表、热榜、相关文章、上一篇/下一篇、RSS 全部排除它——「关于我」不该出现在文章流里。
// 详情(getPublicArticle)与 sitemap 用 PUBLIC_WHERE:单页是真实可访问、也该被索引的 URL。
// 老库没有 is_page 列时由 migrate 补成默认 0,所以这条件对既有数据是恒真的,行为不变。
const POST_WHERE = `${PUBLIC_WHERE} AND COALESCE(a.is_page, 0) = 0`

// ---- 外观(布局 / 皮肤 / 自定义脚本)----

// 页面布局与皮肤(P12.1 / P12.5):跟着 posts / posts/:id 一起下发,不单开端点——
// 布局决定页面骨架、皮肤决定配色,晚到都会导致首屏跳动/闪色。坏配置在各自的 parse 里回落默认。
// 三个键一次 IN 查询取回,不多一趟 D1 往返。
export async function readAppearance(env: Env) {
  const s = await getSettingValues(env, [BLOG_LAYOUT_KEY, BLOG_SKIN_KEY, CUSTOM_JS_KEY])
  return {
    layout: parseBlogLayout(s.get(BLOG_LAYOUT_KEY) || ''),
    skin: parseBlogSkin(s.get(BLOG_SKIN_KEY) || ''),
    custom_js: (s.get(CUSTOM_JS_KEY) || '').slice(0, MAX_CUSTOM_JS),
  }
}

// ---- 按布局装配数据(P12.3)----
// 侧栏模块要的数据随页面响应一起下发,该页没启用的模块一行都不查。
// 目标是「一个页面一次 Worker 请求」:免费额度里请求数(10 万/天)比 D1 行读(500 万/天)紧张得多,
// 所以宁可多几次只读几行的小查询,也不要多一次 HTTP 往返。

export const HOT_WINDOWS: Record<string, string> = { day: '-1 day', week: '-7 day', month: '-30 day' }

export async function hotList(env: Env, win: string) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, a.views FROM articles a
      WHERE ${POST_WHERE} AND COALESCE(a.published_at, a.updated_at) >= datetime('now', ?)
      ORDER BY a.views DESC, COALESCE(a.published_at, a.updated_at) DESC LIMIT 12`
  ).bind(win).all()
  return results || []
}

/** 三档热榜一次下发:切日/周/月 tab 就不必再打一次请求(总共 36 行,可忽略) */
async function fetchHot(env: Env) {
  const [day, week, month] = await Promise.all([
    hotList(env, HOT_WINDOWS.day),
    hotList(env, HOT_WINDOWS.week),
    hotList(env, HOT_WINDOWS.month),
  ])
  return { day, week, month }
}

/** 最新文章模块:全站最新,与列表页当前的筛选无关(否则筛着标签看「最新」会自相矛盾) */
async function fetchRecent(env: Env, limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title FROM articles a
      WHERE ${POST_WHERE} ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ?`
  ).bind(Math.max(1, Math.min(20, limit))).all()
  return results || []
}

/** 标签云:只取两列(不带正文),几百行也很便宜;聚合逻辑在 blogQuery 里可单测 */
async function fetchTagCloud(env: Env) {
  const { results } = await env.DB.prepare(
    `SELECT a.tags, n.name as tag FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${POST_WHERE} LIMIT 1000`
  ).all<{ tags: string | null; tag: string | null }>()
  return buildTagCloud((results || []).map((r) => ({ tag: r.tag, tags: parseTags(r.tags) })))
}

// ---- 卡片型数据(P12.4:幻灯片 / 文章宫格 / 相关文章 / 上下篇)----
// 这几个模块都要缩略图,故读正文前 2000 字符抽首图;但每次只读 3–12 行,比列表页轻得多。

const CARD_COLS =
  'a.id, a.title, SUBSTR(a.content, 1, 2000) as head, a.published_at, a.updated_at, a.views, a.tags, a.notebook_id, n.name as tag'

function toCard(r: any) {
  return {
    id: r.id,
    title: r.title,
    thumb: mdFirstImage(r.head || ''),
    excerpt: mdExcerpt(r.head || '', 60),
    tag: r.tag || '未分类',
    tags: parseTags(r.tags),
    notebook_id: r.notebook_id ?? null,
    published_at: r.published_at || r.updated_at,
    views: r.views || 0,
  }
}

const clampCount = (v: unknown, def: number, max: number) => {
  const n = Math.floor(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : def
}

/** 幻灯片/宫格的取数:最新 / 最热 / 某标签 */
async function fetchCards(env: Env, source: string, tag: string, limit: number) {
  const cond = [POST_WHERE]
  const args: unknown[] = []
  if (source === 'tag' && tag) {
    cond.push("(n.name = ? OR a.tags LIKE ? ESCAPE '\\')")
    args.push(tag, tagLikePattern(tag))
  }
  const order = source === 'hot' ? 'a.views DESC, COALESCE(a.published_at, a.updated_at) DESC' : 'COALESCE(a.published_at, a.updated_at) DESC'
  const { results } = await env.DB.prepare(
    `SELECT ${CARD_COLS} FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${cond.join(' AND ')} ORDER BY ${order} LIMIT ?`
  ).bind(...args, limit).all<any>()
  return (results || []).map(toCard)
}

/** 相关文章:候选集 = 同笔记本或有共同标签,打分排序在 blogQuery.scoreRelated(可单测) */
async function fetchRelated(env: Env, seed: ArticleSeed, limit: number) {
  const or: string[] = []
  const args: unknown[] = [seed.id]
  if (seed.notebook_id != null) { or.push('a.notebook_id = ?'); args.push(seed.notebook_id) }
  for (const t of seed.tags.slice(0, 5)) { or.push("a.tags LIKE ? ESCAPE '\\'"); args.push(tagLikePattern(t)) }
  if (or.length === 0) return []
  const { results } = await env.DB.prepare(
    `SELECT ${CARD_COLS} FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${POST_WHERE} AND a.id != ? AND (${or.join(' OR ')})
      ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT 20`
  ).bind(...args).all<any>()
  return scoreRelated(seed, (results || []).map(toCard), limit)
}

/** 上一篇(更新)/ 下一篇(更早):与列表顺序一致,各一条 LIMIT 1 */
async function fetchNeighbors(env: Env, id: number, sortKey: string) {
  const one = async (cmp: '>' | '<', dir: 'ASC' | 'DESC') => {
    const r = await env.DB.prepare(
      `SELECT ${CARD_COLS} FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
        WHERE ${POST_WHERE} AND a.id != ? AND COALESCE(a.published_at, a.updated_at) ${cmp} ?
        ORDER BY COALESCE(a.published_at, a.updated_at) ${dir} LIMIT 1`
    ).bind(id, sortKey).first<any>()
    return r ? toCard(r) : null
  }
  const [prev, next] = await Promise.all([one('>', 'ASC'), one('<', 'DESC')])
  return { prev, next }
}

/** 当前文章:详情页的 prevnext / related 要用 */
export interface ArticleSeed {
  id: number
  notebook_id: number | null
  tags: string[]
  sortKey: string
}

/** 该页布局用得上的那几份数据(并发取);没启用的模块对应字段直接不出现在响应里 */
export async function widgetData(env: Env, page: PageLayout, article?: ArticleSeed) {
  const uses = (t: Parameters<typeof pageUsesWidget>[1]) => pageUsesWidget(page, t)
  const [hot, recent, tagCloud, slider, grid, related, neighbors] = await Promise.all([
    uses('hot') ? fetchHot(env) : Promise.resolve(null),
    uses('recent') ? fetchRecent(env, maxWidgetOption(page, 'recent', 'count', 8)) : Promise.resolve(null),
    uses('tags') ? fetchTagCloud(env) : Promise.resolve(null),
    uses('slider')
      ? fetchCards(
          env,
          firstWidgetOption(page, 'slider', 'source', 'recent'),
          firstWidgetOption(page, 'slider', 'tag', ''),
          clampCount(maxWidgetOption(page, 'slider', 'count', 5), 5, 8)
        )
      : Promise.resolve(null),
    uses('postgrid')
      ? fetchCards(
          env,
          firstWidgetOption(page, 'postgrid', 'source', 'recent'),
          firstWidgetOption(page, 'postgrid', 'tag', ''),
          clampCount(maxWidgetOption(page, 'postgrid', 'count', 6), 6, 12)
        )
      : Promise.resolve(null),
    uses('related') && article
      ? fetchRelated(env, article, clampCount(maxWidgetOption(page, 'related', 'count', 4), 4, 8))
      : Promise.resolve(null),
    uses('prevnext') && article ? fetchNeighbors(env, article.id, article.sortKey) : Promise.resolve(null),
  ])
  const out: Record<string, unknown> = {}
  if (hot) out.hot = hot
  if (recent) out.recent = recent
  if (tagCloud) out.tag_cloud = tagCloud
  if (slider) out.slider = slider
  if (grid) out.grid = grid
  if (related) out.related = related
  if (neighbors) out.neighbors = neighbors
  return out
}

// ---- 列表 / 详情 / 分享 ----

/**
 * 公开文章列表(分页 + 标签/关键词筛选)。
 * 分页用「加载更多」:多取一行判断 has_more,不做 COUNT(*)
 * (多一次全表扫描只为了显示总数不值)。故这里返回的 rows 可能比 limit 多一行,由调用方切掉。
 */
export async function listPosts(
  env: Env, opts: { limit: number; offset: number; tag?: string; q?: string },
): Promise<{ rows: any[]; hasMore: boolean }> {
  const cond: string[] = [POST_WHERE]
  const args: unknown[] = []
  if (opts.tag) {
    // 笔记本名与文章标签同等对待(博客上「Tags:」本就是混着显示的)
    cond.push("(n.name = ? OR a.tags LIKE ? ESCAPE '\\')")
    args.push(opts.tag, tagLikePattern(opts.tag))
  }
  if (opts.q) {
    cond.push("(a.title LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')")
    args.push(textLikePattern(opts.q), textLikePattern(opts.q))
  }
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, SUBSTR(a.content, 1, 2000) as head,
            a.published_at, a.updated_at, a.views, a.tags, n.name as tag
     FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
     WHERE ${cond.join(' AND ')}
     ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ? OFFSET ?`
  ).bind(...args, opts.limit + 1, opts.offset).all<any>()
  const rows = results || []
  return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit }
}

/**
 * 详情页那一行。用 PUBLIC_WHERE 而不是 POST_WHERE:单页该能被直接访问。
 * 注意选出的列就是「允许进公开响应」的那些 —— 唯一的例外是 notebook_id,
 * 它只用于「相关文章」打分,由调用方摘掉。
 */
export async function getPublicArticle(env: Env, id: string) {
  return env.DB.prepare(
    `SELECT a.id, a.title, a.content, a.published_at, a.updated_at, a.views, a.tags, a.notebook_id,
            COALESCE(a.is_page, 0) as is_page, n.name as tag
     FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
     WHERE a.id = ? AND ${PUBLIC_WHERE}`
  ).bind(id).first<any>()
}

/**
 * 私密分享(P9.3,unlisted):凭 token 可读,**不看 is_public**——它本来就不在列表里。
 * 私有与回收站中的笔记仍然不可达;有效期由调用方判定(要区分 404 与 410)。
 */
export async function getSharedArticle(env: Env, token: string) {
  return env.DB.prepare(
    `SELECT a.id, a.title, a.content, a.published_at, a.updated_at, a.views, a.tags, a.share_expires_at, n.name as tag
     FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
     WHERE a.share_token = ? AND a.is_private = 0 AND a.deleted_at IS NULL`
  ).bind(token).first<any>()
}

/** 浏览数 +1。返回 Promise 而不 await:调用方可能要塞进 waitUntil 不阻塞响应 */
export function incrementViews(env: Env, id: string): Promise<unknown> {
  return env.DB.prepare('UPDATE articles SET views = COALESCE(views, 0) + 1 WHERE id = ?').bind(id).run()
}

// sitemap.xml 用:全部公开文章的 id 与更新时间(只读两列,几千行也很便宜)。
// 这里用 PUBLIC_WHERE 而不是 POST_WHERE:单页是真实可访问的 URL,该被索引。
export async function listSitemapPosts(env: Env, limit = 5000) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, COALESCE(a.updated_at, a.published_at) as updated_at FROM articles a
      WHERE ${PUBLIC_WHERE} ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ?`
  ).bind(limit).all<{ id: number; updated_at: string }>()
  return results || []
}

// RSS 用:最近若干篇,摘要取正文前 2000 字符再剥语法(与列表页同一条路径)。
// 用 POST_WHERE:feed 是「订阅新文章」,单页不该出现在里面。
export async function listFeedPosts(env: Env, limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, SUBSTR(a.content, 1, 2000) as head, a.published_at, a.updated_at, n.name as tag
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${POST_WHERE} ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ?`
  ).bind(limit).all<any>()
  return (results || []).map((r) => ({
    id: r.id,
    title: r.title,
    excerpt: mdExcerpt(r.head || '', 200),
    published_at: r.published_at || r.updated_at,
    tag: r.tag || '未分类',
  }))
}

// ---- 评论(P11.2)----
// 这三个查询原先写在路由里,而且「目标文章必须公开」那个条件是手抄的
// (is_public = 1 AND is_private = 0 AND deleted_at IS NULL),没用 PUBLIC_WHERE。
// 搬到这里之后共用同一个常量:条件逐字相同,行为不变,但从此改一处即可。

/** 评论的目标文章:必须是公开文章(单页也算,单页可以收评论)。返回标题供待审通知用 */
export async function getCommentTarget(env: Env, articleId: number) {
  return env.DB.prepare(
    `SELECT a.id, a.title FROM articles a WHERE a.id = ? AND ${PUBLIC_WHERE}`
  ).bind(articleId).first<{ id: number; title: string }>()
}

/** 某文章的已通过评论(扁平,线程装配在 src/lib/comments.buildThread) */
export async function listApprovedComments(env: Env, articleId: number): Promise<FlatComment[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, parent_id, root_id, author_name, content, is_admin, created_at
       FROM comments WHERE article_id = ? AND status = 'approved'
      ORDER BY created_at ASC LIMIT 500`
  ).bind(articleId).all<FlatComment>()
  return (results || []) as FlatComment[]
}

/** 被回复的那条评论(必须同文章且已通过);2 层夹取由 comments.resolveThreadParent 算 */
export async function getApprovedComment(env: Env, id: number, articleId: number) {
  return env.DB.prepare(
    "SELECT id, root_id FROM comments WHERE id = ? AND article_id = ? AND status = 'approved'"
  ).bind(id, articleId).first<{ id: number; root_id: number | null }>()
}

export interface NewComment {
  articleId: number
  parentId: number | null
  rootId: number | null
  name: string
  email: string | null
  content: string
  status: string
  ip: string | null
  userAgent: string | null
}

/** 插入一条访客评论,返回新 id(0 表示拿不到) */
export async function insertComment(env: Env, cm: NewComment): Promise<number> {
  const ins = await env.DB.prepare(
    `INSERT INTO comments (article_id, parent_id, root_id, author_name, author_email, content, status, is_admin, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).bind(cm.articleId, cm.parentId, cm.rootId, cm.name, cm.email, cm.content, cm.status, cm.ip, cm.userAgent).run()
  return Number(ins.meta?.last_row_id) || 0
}
