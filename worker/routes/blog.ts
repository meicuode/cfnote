import { Hono } from 'hono'
import { ok, err, getSettingValue, getSettingValues } from '../utils'
import { mdExcerpt, mdFirstImage } from '../../src/lib/blogExtract'
import { parseTags } from '../../src/types'
import { validateCommentInput, resolveThreadParent, buildThread, isHoneypotTripped, type FlatComment } from '../../src/lib/comments'
import { parseBlogLayout, pageUsesWidget, maxWidgetOption, firstWidgetOption, BLOG_LAYOUT_KEY, type PageLayout } from '../../src/lib/blogLayout'
import { parseBlogSkin, BLOG_SKIN_KEY } from '../../src/lib/blogSkin'
import {
  clampLimit, clampOffset, tagLikePattern, textLikePattern, buildTagCloud, scoreRelated, MAX_QUERY_LEN,
} from '../../src/lib/blogQuery'
import { notifyPendingComment } from './notify'
import type { AppEnv } from '../types'

// 公开博客只读接口(免登录,见 worker/index.ts 的 auth skip)。
// 只暴露 is_public=1 且非私有的文章;私有/未公开的任何字段都不可达。
export const blog = new Hono<AppEnv>()

// 只读列表的公共 WHERE(所有公开查询共用同一把尺子,避免哪天漏掉一个条件把私有文章漏出去)
const PUBLIC_WHERE = 'a.is_public = 1 AND a.is_private = 0 AND a.deleted_at IS NULL'

// 页面布局与皮肤(P12.1 / P12.5):跟着 posts / posts/:id 一起下发,不单开端点——
// 布局决定页面骨架、皮肤决定配色,晚到都会导致首屏跳动/闪色。坏配置在各自的 parse 里回落默认。
// 两个键一次 IN 查询取回,不多一趟 D1 往返。
async function readAppearance(env: AppEnv['Bindings']) {
  const s = await getSettingValues(env, [BLOG_LAYOUT_KEY, BLOG_SKIN_KEY])
  return { layout: parseBlogLayout(s.get(BLOG_LAYOUT_KEY) || ''), skin: parseBlogSkin(s.get(BLOG_SKIN_KEY) || '') }
}

// ---- 按布局装配数据(P12.3)----
// 侧栏模块要的数据随页面响应一起下发,该页没启用的模块一行都不查。
// 目标是「一个页面一次 Worker 请求」:免费额度里请求数(10 万/天)比 D1 行读(500 万/天)紧张得多,
// 所以宁可多几次只读几行的小查询,也不要多一次 HTTP 往返。

const HOT_WINDOWS: Record<string, string> = { day: '-1 day', week: '-7 day', month: '-30 day' }

async function hotList(env: AppEnv['Bindings'], win: string) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, a.views FROM articles a
      WHERE ${PUBLIC_WHERE} AND COALESCE(a.published_at, a.updated_at) >= datetime('now', ?)
      ORDER BY a.views DESC, COALESCE(a.published_at, a.updated_at) DESC LIMIT 12`
  ).bind(win).all()
  return results || []
}

/** 三档热榜一次下发:切日/周/月 tab 就不必再打一次请求(总共 36 行,可忽略) */
async function fetchHot(env: AppEnv['Bindings']) {
  const [day, week, month] = await Promise.all([
    hotList(env, HOT_WINDOWS.day),
    hotList(env, HOT_WINDOWS.week),
    hotList(env, HOT_WINDOWS.month),
  ])
  return { day, week, month }
}

/** 最新文章模块:全站最新,与列表页当前的筛选无关(否则筛着标签看「最新」会自相矛盾) */
async function fetchRecent(env: AppEnv['Bindings'], limit: number) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title FROM articles a
      WHERE ${PUBLIC_WHERE} ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ?`
  ).bind(Math.max(1, Math.min(20, limit))).all()
  return results || []
}

/** 标签云:只取两列(不带正文),几百行也很便宜;聚合逻辑在 blogQuery 里可单测 */
async function fetchTagCloud(env: AppEnv['Bindings']) {
  const { results } = await env.DB.prepare(
    `SELECT a.tags, n.name as tag FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${PUBLIC_WHERE} LIMIT 1000`
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
async function fetchCards(env: AppEnv['Bindings'], source: string, tag: string, limit: number) {
  const cond = [PUBLIC_WHERE]
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
async function fetchRelated(env: AppEnv['Bindings'], seed: { id: number; notebook_id: number | null; tags: string[] }, limit: number) {
  const or: string[] = []
  const args: unknown[] = [seed.id]
  if (seed.notebook_id != null) { or.push('a.notebook_id = ?'); args.push(seed.notebook_id) }
  for (const t of seed.tags.slice(0, 5)) { or.push("a.tags LIKE ? ESCAPE '\\'"); args.push(tagLikePattern(t)) }
  if (or.length === 0) return []
  const { results } = await env.DB.prepare(
    `SELECT ${CARD_COLS} FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${PUBLIC_WHERE} AND a.id != ? AND (${or.join(' OR ')})
      ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT 20`
  ).bind(...args).all<any>()
  return scoreRelated(seed, (results || []).map(toCard), limit)
}

/** 上一篇(更新)/ 下一篇(更早):与列表顺序一致,各一条 LIMIT 1 */
async function fetchNeighbors(env: AppEnv['Bindings'], id: number, sortKey: string) {
  const one = async (cmp: '>' | '<', dir: 'ASC' | 'DESC') => {
    const r = await env.DB.prepare(
      `SELECT ${CARD_COLS} FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
        WHERE ${PUBLIC_WHERE} AND a.id != ? AND COALESCE(a.published_at, a.updated_at) ${cmp} ?
        ORDER BY COALESCE(a.published_at, a.updated_at) ${dir} LIMIT 1`
    ).bind(id, sortKey).first<any>()
    return r ? toCard(r) : null
  }
  const [prev, next] = await Promise.all([one('>', 'ASC'), one('<', 'DESC')])
  return { prev, next }
}

/** 当前文章:详情页的 prevnext / related 要用 */
interface ArticleSeed {
  id: number
  notebook_id: number | null
  tags: string[]
  sortKey: string
}

/** 该页布局用得上的那几份数据(并发取);没启用的模块对应字段直接不出现在响应里 */
async function widgetData(env: AppEnv['Bindings'], page: PageLayout, article?: ArticleSeed) {
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

// GET /api/blog/posts - 公开文章列表(分页 + 标签/关键词筛选)+ 列表页布局 + 该页模块数据
// 分页用「加载更多」:多取一行判断 has_more,不做 COUNT(*)(多一次全表扫描只为了显示总数不值)
blog.get('/posts', async (c) => {
  try {
    const limit = clampLimit(c.req.query('limit'))
    const offset = clampOffset(c.req.query('offset'))
    const tag = (c.req.query('tag') || '').trim().slice(0, MAX_QUERY_LEN)
    const q = (c.req.query('q') || '').trim().slice(0, MAX_QUERY_LEN)
    const cond: string[] = [PUBLIC_WHERE]
    const args: unknown[] = []
    if (tag) {
      // 笔记本名与文章标签同等对待(博客上「Tags:」本就是混着显示的)
      cond.push("(n.name = ? OR a.tags LIKE ? ESCAPE '\\')")
      args.push(tag, tagLikePattern(tag))
    }
    if (q) {
      cond.push("(a.title LIKE ? ESCAPE '\\' OR a.content LIKE ? ESCAPE '\\')")
      args.push(textLikePattern(q), textLikePattern(q))
    }
    const [{ results }, appearance] = await Promise.all([
      c.env.DB.prepare(
        `SELECT a.id, a.title, SUBSTR(a.content, 1, 2000) as head,
                a.published_at, a.updated_at, a.views, a.tags, n.name as tag
         FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
         WHERE ${cond.join(' AND ')}
         ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ? OFFSET ?`
      ).bind(...args, limit + 1, offset).all<any>(),
      readAppearance(c.env),
    ])
    const { layout, skin } = appearance
    const rows = results || []
    const hasMore = rows.length > limit
    return ok({
      posts: rows.slice(0, limit).map((r) => ({
        id: r.id,
        title: r.title,
        tag: r.tag || '未分类',
        tags: parseTags(r.tags),
        excerpt: mdExcerpt(r.head || '', 120),
        thumb: mdFirstImage(r.head || ''),
        published_at: r.published_at || r.updated_at,
        views: r.views || 0,
      })),
      has_more: hasMore,
      layout,
      skin,
      ...(await widgetData(c.env, layout.list)),
    })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// 浏览计数去重:同一 IP 对同一文章 1 小时内只计 1 次。
// 用 Cache API(caches.default)存去重标记——免费、零配额、不占 D1 写额度;按数据中心(colo)生效,
// 个人博客量级足够。缓存不可用的环境(本地 dev / workers.dev 域名)自动退化为每次计数。
async function shouldCountView(id: string, ip: string): Promise<boolean> {
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ip))
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    const key = new Request(`https://view-dedupe.cfnote.internal/${id}/${hex}`)
    // 类型断言:tsconfig 同时含 DOM lib,caches 解析为 DOM CacheStorage(无 default);运行时是 Workers 的 caches.default
    const cache = (caches as unknown as { default: Cache }).default
    if (await cache.match(key)) return false
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'public, max-age=3600' } }))
    return true
  } catch {
    return true
  }
}

// 评论限流:每 IP 每分钟至多 1 条(Cache API,与浏览计数同款——零配额、按 colo 生效、缓存不可用时优雅降级为放行)
async function commentRateLimited(ip: string): Promise<boolean> {
  if (!ip) return false
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode('cmt:' + ip))
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
    const key = new Request(`https://comment-rl.cfnote.internal/${hex}`)
    const cache = (caches as unknown as { default: Cache }).default
    if (await cache.match(key)) return true
    await cache.put(key, new Response('1', { headers: { 'Cache-Control': 'public, max-age=60' } }))
    return false
  } catch {
    return false
  }
}

/**
 * 浏览计数(去重后 +1)。返回是否真的计了数。
 * 独立导出是因为 HTML 预渲染命中边缘缓存时不会走 loadBlogDetail,但那一次访问同样要计数——
 * 否则一分钟内的缓存窗口里所有访客都不算数。
 */
export async function countBlogView(
  env: AppEnv['Bindings'],
  id: string,
  ip: string,
  waitUntil?: (p: Promise<unknown>) => void
): Promise<boolean> {
  if (!(await shouldCountView(id, ip))) return false
  const p = env.DB.prepare('UPDATE articles SET views = COALESCE(views, 0) + 1 WHERE id = ?').bind(id).run()
  if (waitUntil) waitUntil(p)
  else await p
  return true
}

// 详情页取数(P12.6 抽出):HTML 预渲染与 JSON 接口共用同一份逻辑。
// 抽出来的理由是 PUBLIC_WHERE 这把尺子和「哪些字段可以出现在公开响应里」的判断只能有一处——
// 预渲染另写一份查询,迟早会漏掉某个条件把未公开的文章漏出去。
// 返回值就是 GET /api/blog/posts/:id 的 data;文章不存在/未公开返回 null。
export async function loadBlogDetail(
  env: AppEnv['Bindings'],
  id: string,
  opts: { preview?: boolean; ip?: string; waitUntil?: (p: Promise<unknown>) => void } = {}
): Promise<Record<string, any> | null> {
  const [a, settings] = await Promise.all([
    env.DB.prepare(
      `SELECT a.id, a.title, a.content, a.published_at, a.updated_at, a.views, a.tags, a.notebook_id, n.name as tag
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.id = ? AND ${PUBLIC_WHERE}`
    ).bind(id).first<any>(),
    getSettingValues(env, [BLOG_LAYOUT_KEY, BLOG_SKIN_KEY, 'comments_enabled']),
  ])
  if (!a) return null
  const layout = parseBlogLayout(settings.get(BLOG_LAYOUT_KEY) || '')
  const skin = parseBlogSkin(settings.get(BLOG_SKIN_KEY) || '')
  const counted = !opts.preview && (await countBlogView(env, id, opts.ip || '', opts.waitUntil))
  // notebook_id 只用于「相关文章」打分,不进公开响应
  const { notebook_id, ...pub } = a
  const tags = parseTags(a.tags)
  const seed = { id: a.id, notebook_id: notebook_id ?? null, tags, sortKey: a.published_at || a.updated_at }
  return {
    ...pub,
    tag: a.tag || '未分类',
    tags,
    comments_enabled: (settings.get('comments_enabled') ?? '1') !== '0',
    layout,
    skin,
    ...(await widgetData(env, layout.detail, seed)),
    published_at: a.published_at || a.updated_at,
    views: (a.views || 0) + (counted ? 1 : 0),
  }
}

// GET /api/blog/posts/:id - 公开文章详情(浏览计数:去重后 +1,waitUntil 不阻塞响应)
// 详情页要的一切(布局 + 侧栏模块数据 + 评论开关)都在这一次响应里,前端不再另拉列表与热榜。
// ?preview=1:布局配置页的 iframe 预览用,不计浏览量——否则调一次布局就给自己刷一次量。
// 注:预渲染开启(默认)时详情页的 HTML 已内联这份数据,前端不会再打这个端点;此处保留供预览、
// 私密分享回退以及关闭预渲染的场景使用。
blog.get('/posts/:id', async (c) => {
  try {
    const data = await loadBlogDetail(c.env, c.req.param('id'), {
      preview: c.req.query('preview') === '1',
      ip: c.req.header('cf-connecting-ip') || '',
      waitUntil: (p) => c.executionCtx.waitUntil(p),
    })
    if (!data) return err('文章不存在或未公开', 404)
    return ok(data)
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// sitemap.xml 用:全部公开文章的 id 与更新时间(只读两列,几千行也很便宜)
export async function listSitemapPosts(env: AppEnv['Bindings'], limit = 5000) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, COALESCE(a.updated_at, a.published_at) as updated_at FROM articles a
      WHERE ${PUBLIC_WHERE} ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ?`
  ).bind(limit).all<{ id: number; updated_at: string }>()
  return results || []
}

// RSS 用:最近若干篇,摘要取正文前 2000 字符再剥语法(与列表页同一条路径)
export async function listFeedPosts(env: AppEnv['Bindings'], limit = 20) {
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, SUBSTR(a.content, 1, 2000) as head, a.published_at, a.updated_at, n.name as tag
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE ${PUBLIC_WHERE} ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT ?`
  ).bind(limit).all<any>()
  return (results || []).map((r) => ({
    id: r.id,
    title: r.title,
    excerpt: mdExcerpt(r.head || '', 200),
    published_at: r.published_at || r.updated_at,
    tag: r.tag || '未分类',
  }))
}

// GET /api/blog/share/:token - 私密分享的笔记(P9.3,unlisted):
// 有 token 即可看,不出现在列表/热榜;过期 410;私有/回收站中的笔记不可达;不计浏览量
blog.get('/share/:token', async (c) => {
  const token = String(c.req.param('token') || '')
  if (!/^[0-9a-f]{32}$/.test(token)) return err('分享不存在或已取消', 404)
  try {
    const a = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.content, a.published_at, a.updated_at, a.views, a.tags, a.share_expires_at, n.name as tag
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.share_token = ? AND a.is_private = 0 AND a.deleted_at IS NULL`
    ).bind(token).first<any>()
    if (!a) return err('分享不存在或已取消', 404)
    if (a.share_expires_at && Date.parse(a.share_expires_at) <= Date.now()) {
      return err('分享链接已过期', 410)
    }
    const { layout, skin } = await readAppearance(c.env)
    return ok({
      ...a,
      shared: true,
      tag: a.tag || '未分类',
      tags: parseTags(a.tags),
      layout,
      skin,
      ...(await widgetData(c.env, layout.detail)),
      published_at: a.published_at || a.updated_at,
      views: a.views || 0,
    })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/blog/hot?range=day|week|month - 热榜(时间窗内发布的文章按浏览量排序)。
// 博客页已改为随页面响应拿三档热榜(切 tab 零请求),此端点保留供直接调用。
blog.get('/hot', async (c) => {
  const range = c.req.query('range') || 'day'
  try {
    return ok(await hotList(c.env, HOT_WINDOWS[range] || HOT_WINDOWS.day))
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/blog/comments?article_id=<id> - 某公开文章的已通过评论(2 层线程)。免登录(见 index.ts GET skip)。
blog.get('/comments', async (c) => {
  const articleId = Number(c.req.query('article_id'))
  if (!Number.isInteger(articleId) || articleId <= 0) return err('参数错误', 400)
  try {
    // 仅公开文章可读评论
    const art = await c.env.DB.prepare(
      'SELECT id FROM articles WHERE id = ? AND is_public = 1 AND is_private = 0 AND deleted_at IS NULL'
    ).bind(articleId).first()
    if (!art) return ok([])
    const { results } = await c.env.DB.prepare(
      `SELECT id, parent_id, root_id, author_name, content, is_admin, created_at
         FROM comments WHERE article_id = ? AND status = 'approved'
        ORDER BY created_at ASC LIMIT 500`
    ).bind(articleId).all<FlatComment>()
    return ok(buildThread((results || []) as FlatComment[]))
  } catch (e: any) {
    return err('获取评论失败: ' + e.message, 500)
  }
})

// POST /api/blog/comments - 访客提交评论(无鉴权;index.ts 中间件为该确切路径放行 POST)。
// 默认进待审核队列(设置可切自动通过);蜜罐 + 每 IP 每分钟限流;2 层夹取。
blog.post('/comments', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => null)
    if (!body) return err('参数错误', 400)
    // 蜜罐命中:静默假成功,不入库(不给机器人反馈)
    if (isHoneypotTripped(body.website)) return ok({ status: 'pending' })
    const articleId = Number(body.article_id)
    if (!Number.isInteger(articleId) || articleId <= 0) return err('参数错误', 400)
    if ((await getSettingValue(c.env, 'comments_enabled', '1')) === '0') return err('评论已关闭', 403)
    const v = validateCommentInput({ name: body.author_name, content: body.content, email: body.author_email })
    if (!v.ok) return err(v.error || '内容不合法', 400)
    // 目标文章必须公开
    const art = await c.env.DB.prepare(
      'SELECT id, title FROM articles WHERE id = ? AND is_public = 1 AND is_private = 0 AND deleted_at IS NULL'
    ).bind(articleId).first<{ id: number; title: string }>()
    if (!art) return err('文章不存在或未公开', 404)
    // 限流
    const ip = c.req.header('cf-connecting-ip') || ''
    if (await commentRateLimited(ip)) return err('评论太频繁,请稍后再试', 429)
    // 2 层夹取:回复某条已通过评论时取其顶层楼
    let parent_id: number | null = null
    let root_id: number | null = null
    const rawParent = Number(body.parent_id)
    if (Number.isInteger(rawParent) && rawParent > 0) {
      const p = await c.env.DB.prepare(
        "SELECT id, root_id FROM comments WHERE id = ? AND article_id = ? AND status = 'approved'"
      ).bind(rawParent, articleId).first<{ id: number; root_id: number | null }>()
      if (p) { const r = resolveThreadParent(p); parent_id = r.parent_id; root_id = r.root_id }
    }
    const autoApprove = (await getSettingValue(c.env, 'comments_auto_approve', '0')) === '1'
    const status = autoApprove ? 'approved' : 'pending'
    const name = String(body.author_name).trim()
    const email = body.author_email ? String(body.author_email).trim() : null
    const content = String(body.content).trim()
    // 明文 IP 与 UA(P11.9):仅管理端可见(公开 GET 从不返回),用于识别刷评论/垃圾评论来源。
    // 原先只存无盐 SHA-1——IPv4 空间仅 43 亿,彩虹表几秒即可还原,那点保护是自我安慰,故不再写。
    const ua = (c.req.header('user-agent') || '').slice(0, 300) // 截断:避免超长 UA 撑大行
    const ins = await c.env.DB.prepare(
      `INSERT INTO comments (article_id, parent_id, root_id, author_name, author_email, content, status, is_admin, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).bind(articleId, parent_id, root_id, name, email || null, content, status, ip || null, ua || null).run()
    if (status === 'pending') {
      c.executionCtx.waitUntil(notifyPendingComment(c.env, { articleId, articleTitle: art.title, author: name, content }))
    }
    // 回传 id/父子关系/时间:待审时前端据此把这条评论就地渲染为「待审核」占位(P11.7)
    const id = Number(ins.meta?.last_row_id) || 0
    return ok({ status, id, parent_id, root_id: root_id ?? (id || null), created_at: new Date().toISOString() })
  } catch (e: any) {
    return err('提交失败: ' + e.message, 500)
  }
})
