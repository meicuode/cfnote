import { Hono } from 'hono'
import { ok, err, getSettingValue, getSettingValues } from '../utils'
import { mdExcerpt, mdFirstImage } from '../../src/lib/blogExtract'
import { parseTags } from '../../src/types'
import { validateCommentInput, resolveThreadParent, buildThread, isHoneypotTripped } from '../../src/lib/comments'
import { parseBlogLayout, BLOG_LAYOUT_KEY } from '../../src/lib/blogLayout'
import { parseBlogSkin, BLOG_SKIN_KEY } from '../../src/lib/blogSkin'
import { CUSTOM_JS_KEY, MAX_CUSTOM_JS } from '../../src/lib/blogScripts'
import { clampLimit, clampOffset, MAX_QUERY_LEN } from '../../src/lib/blogQuery'
import { notifyPendingComment } from './notify'
import * as repo from '../repo/blogRepo'
import type { AppEnv } from '../types'

// 公开博客只读接口(免登录,见 worker/index.ts 的 auth skip)。
// 只暴露 is_public=1 且非私有的文章;私有/未公开的任何字段都不可达。
//
// 本文件不含 SQL(P13.5):取数与「哪些列能进公开响应」都在 worker/repo/blogRepo.ts,
// 那两条判断是安全不变量,散在十来个查询点上时抄漏一次就是把未公开的文章漏出去。
// 这里只做请求解析、响应装配,以及两件与 D1 无关的事:浏览计数去重与评论限流(都用 Cache API)。
export const blog = new Hono<AppEnv>()

// GET /api/blog/posts - 公开文章列表(分页 + 标签/关键词筛选)+ 列表页布局 + 该页模块数据
blog.get('/posts', async (c) => {
  try {
    const [{ rows, hasMore }, appearance] = await Promise.all([
      repo.listPosts(c.env, {
        limit: clampLimit(c.req.query('limit')),
        offset: clampOffset(c.req.query('offset')),
        tag: (c.req.query('tag') || '').trim().slice(0, MAX_QUERY_LEN),
        q: (c.req.query('q') || '').trim().slice(0, MAX_QUERY_LEN),
      }),
      repo.readAppearance(c.env),
    ])
    const { layout, skin, custom_js } = appearance
    return ok({
      posts: rows.map((r) => ({
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
      custom_js,
      ...(await repo.widgetData(c.env, layout.list)),
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
  const p = repo.incrementViews(env, id)
  if (waitUntil) waitUntil(p)
  else await p
  return true
}

// 详情页取数(P12.6 抽出):HTML 预渲染与 JSON 接口共用同一份逻辑。
// 抽出来的理由是「哪些字段可以出现在公开响应里」的判断只能有一处——
// 预渲染另写一份装配,迟早会漏掉某处。取数本身在 blogRepo.getPublicArticle(它用 PUBLIC_WHERE)。
// 返回值就是 GET /api/blog/posts/:id 的 data;文章不存在/未公开返回 null。
export async function loadBlogDetail(
  env: AppEnv['Bindings'],
  id: string,
  opts: { preview?: boolean; ip?: string; waitUntil?: (p: Promise<unknown>) => void } = {}
): Promise<Record<string, any> | null> {
  const [a, settings] = await Promise.all([
    repo.getPublicArticle(env, id),
    getSettingValues(env, [BLOG_LAYOUT_KEY, BLOG_SKIN_KEY, CUSTOM_JS_KEY, 'comments_enabled']),
  ])
  if (!a) return null
  const layout = parseBlogLayout(settings.get(BLOG_LAYOUT_KEY) || '')
  const skin = parseBlogSkin(settings.get(BLOG_SKIN_KEY) || '')
  const counted = !opts.preview && (await countBlogView(env, id, opts.ip || '', opts.waitUntil))
  // notebook_id 只用于「相关文章」打分,不进公开响应
  const { notebook_id, ...pub } = a
  const tags = parseTags(a.tags)
  const isPage = !!a.is_page
  const seed = { id: a.id, notebook_id: notebook_id ?? null, tags, sortKey: a.published_at || a.updated_at }
  // 单页(P13.4)走自己那套槽位与部件表——「关于我」不该带面包屑、发布时间和相关文章
  const pageLayout = isPage ? layout.page : layout.detail
  return {
    ...pub,
    is_page: isPage,
    tag: a.tag || '未分类',
    tags,
    comments_enabled: (settings.get('comments_enabled') ?? '1') !== '0',
    layout,
    skin,
    custom_js: (settings.get(CUSTOM_JS_KEY) || '').slice(0, MAX_CUSTOM_JS),
    ...(await repo.widgetData(env, pageLayout, isPage ? undefined : seed)),
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

// sitemap.xml / feed.xml 的取数由 pages.ts 直接调 blogRepo,不经这里。

// GET /api/blog/share/:token - 私密分享的笔记(P9.3,unlisted):
// 有 token 即可看,不出现在列表/热榜;过期 410;私有/回收站中的笔记不可达;不计浏览量
blog.get('/share/:token', async (c) => {
  const token = String(c.req.param('token') || '')
  if (!/^[0-9a-f]{32}$/.test(token)) return err('分享不存在或已取消', 404)
  try {
    const a = await repo.getSharedArticle(c.env, token)
    if (!a) return err('分享不存在或已取消', 404)
    if (a.share_expires_at && Date.parse(a.share_expires_at) <= Date.now()) {
      return err('分享链接已过期', 410)
    }
    // 私密分享页刻意不下发 custom_js:unlisted 的内容不该送到第三方统计里去
    const { layout, skin } = await repo.readAppearance(c.env)
    return ok({
      ...a,
      shared: true,
      tag: a.tag || '未分类',
      tags: parseTags(a.tags),
      layout,
      skin,
      ...(await repo.widgetData(c.env, layout.detail)),
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
    return ok(await repo.hotList(c.env, repo.HOT_WINDOWS[range] || repo.HOT_WINDOWS.day))
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
    if (!(await repo.getCommentTarget(c.env, articleId))) return ok([])
    return ok(buildThread(await repo.listApprovedComments(c.env, articleId)))
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
    const art = await repo.getCommentTarget(c.env, articleId)
    if (!art) return err('文章不存在或未公开', 404)
    // 限流
    const ip = c.req.header('cf-connecting-ip') || ''
    if (await commentRateLimited(ip)) return err('评论太频繁,请稍后再试', 429)
    // 2 层夹取:回复某条已通过评论时取其顶层楼
    let parent_id: number | null = null
    let root_id: number | null = null
    const rawParent = Number(body.parent_id)
    if (Number.isInteger(rawParent) && rawParent > 0) {
      const p = await repo.getApprovedComment(c.env, rawParent, articleId)
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
    const id = await repo.insertComment(c.env, {
      articleId, parentId: parent_id, rootId: root_id, name, email: email || null,
      content, status, ip: ip || null, userAgent: ua || null,
    })
    if (status === 'pending') {
      c.executionCtx.waitUntil(notifyPendingComment(c.env, { articleId, articleTitle: art.title, author: name, content }))
    }
    // 回传 id/父子关系/时间:待审时前端据此把这条评论就地渲染为「待审核」占位(P11.7)
    return ok({ status, id, parent_id, root_id: root_id ?? (id || null), created_at: new Date().toISOString() })
  } catch (e: any) {
    return err('提交失败: ' + e.message, 500)
  }
})
