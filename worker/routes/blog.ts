import { Hono } from 'hono'
import { ok, err } from '../utils'
import { mdExcerpt, mdFirstImage } from '../../src/lib/blogExtract'
import { parseTags } from '../../src/types'
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
    return ok({ ...a, tag: a.tag || '未分类', tags: parseTags(a.tags), published_at: a.published_at || a.updated_at, views: (a.views || 0) + (counted ? 1 : 0) })
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
