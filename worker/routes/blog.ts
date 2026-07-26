import { Hono } from 'hono'
import { ok, err, getSettingValue } from '../utils'
import { mdExcerpt, mdFirstImage } from '../../src/lib/blogExtract'
import { parseTags } from '../../src/types'
import { validateCommentInput, resolveThreadParent, buildThread, isHoneypotTripped, type FlatComment } from '../../src/lib/comments'
import { notifyPendingComment } from './notify'
import type { AppEnv } from '../types'

// 公开博客只读接口(免登录,见 worker/index.ts 的 auth skip)。
// 只暴露 is_public=1 且非私有的文章;私有/未公开的任何字段都不可达。
export const blog = new Hono<AppEnv>()

// GET /api/blog/posts - 公开文章列表(标题/摘要/缩略图/笔记本 tag/发布时间)
blog.get('/posts', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.title, SUBSTR(a.content, 1, 2000) as head,
              a.published_at, a.updated_at, a.views, a.tags, n.name as tag
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.is_public = 1 AND a.is_private = 0 AND a.deleted_at IS NULL
       ORDER BY COALESCE(a.published_at, a.updated_at) DESC LIMIT 100`
    ).all<any>()
    return ok(
      (results || []).map((r) => ({
        id: r.id,
        title: r.title,
        tag: r.tag || '未分类',
        tags: parseTags(r.tags),
        excerpt: mdExcerpt(r.head || '', 120),
        thumb: mdFirstImage(r.head || ''),
        published_at: r.published_at || r.updated_at,
        views: r.views || 0,
      }))
    )
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

async function sha1hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

// GET /api/blog/posts/:id - 公开文章详情(浏览计数:去重后 +1,waitUntil 不阻塞响应)
blog.get('/posts/:id', async (c) => {
  const id = c.req.param('id')
  try {
    const a = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.content, a.published_at, a.updated_at, a.views, a.tags, n.name as tag
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.id = ? AND a.is_public = 1 AND a.is_private = 0 AND a.deleted_at IS NULL`
    ).bind(id).first<any>()
    if (!a) return err('文章不存在或未公开', 404)
    const counted = await shouldCountView(id, c.req.header('cf-connecting-ip') || '')
    if (counted) {
      c.executionCtx.waitUntil(
        c.env.DB.prepare('UPDATE articles SET views = COALESCE(views, 0) + 1 WHERE id = ?').bind(id).run()
      )
    }
    const commentsEnabled = (await getSettingValue(c.env, 'comments_enabled', '1')) !== '0'
    return ok({ ...a, tag: a.tag || '未分类', tags: parseTags(a.tags), comments_enabled: commentsEnabled, published_at: a.published_at || a.updated_at, views: (a.views || 0) + (counted ? 1 : 0) })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

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
    return ok({
      ...a,
      shared: true,
      tag: a.tag || '未分类',
      tags: parseTags(a.tags),
      published_at: a.published_at || a.updated_at,
      views: a.views || 0,
    })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/blog/hot?range=day|week|month - 热榜(时间窗内发布的文章按浏览量排序)
blog.get('/hot', async (c) => {
  const range = c.req.query('range') || 'day'
  const windows: Record<string, string> = { day: '-1 day', week: '-7 day', month: '-30 day' }
  const win = windows[range] || windows.day
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, title, views FROM articles
       WHERE is_public = 1 AND is_private = 0 AND COALESCE(published_at, updated_at) >= datetime('now', ?)
       ORDER BY views DESC, COALESCE(published_at, updated_at) DESC LIMIT 12`
    ).bind(win).all()
    return ok(results)
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
    const ipHash = ip ? await sha1hex(ip) : null
    await c.env.DB.prepare(
      `INSERT INTO comments (article_id, parent_id, root_id, author_name, author_email, content, status, is_admin, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(articleId, parent_id, root_id, name, email || null, content, status, ipHash).run()
    if (status === 'pending') {
      c.executionCtx.waitUntil(notifyPendingComment(c.env, { articleId, articleTitle: art.title, author: name, content }))
    }
    return ok({ status })
  } catch (e: any) {
    return err('提交失败: ' + e.message, 500)
  }
})
