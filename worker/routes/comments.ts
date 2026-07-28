import { Hono } from 'hono'
import { ok, err } from '../utils'
import { resolveThreadParent } from '../../src/lib/comments'
import type { AppEnv } from '../types'

// 评论管理(P11.2,鉴权;单用户=账号所有者即管理员)。所有权经 JOIN articles.user_id 判定。
export const comments = new Hono<AppEnv>()

// GET /api/comments?status=pending|approved|rejected|all&article_id= - 审核列表
comments.get('/', async (c) => {
  const user = c.get('user')
  const status = c.req.query('status') || 'pending'
  const articleId = Number(c.req.query('article_id'))
  try {
    const conds = ['a.user_id = ?']
    const binds: any[] = [user.id]
    if (status === 'pending' || status === 'approved' || status === 'rejected') { conds.push('cm.status = ?'); binds.push(status) }
    if (Number.isInteger(articleId) && articleId > 0) { conds.push('cm.article_id = ?'); binds.push(articleId) }
    const { results } = await c.env.DB.prepare(
      `SELECT cm.id, cm.article_id, cm.parent_id, cm.root_id, cm.author_name, cm.author_email,
              cm.content, cm.status, cm.is_admin, cm.created_at, cm.ip, cm.user_agent, a.title AS article_title
         FROM comments cm JOIN articles a ON a.id = cm.article_id
        WHERE ${conds.join(' AND ')}
        ORDER BY cm.created_at DESC LIMIT 300`
    ).bind(...binds).all()
    return ok(results)
  } catch (e: any) {
    return err('获取评论失败: ' + e.message, 500)
  }
})

// GET /api/comments/counts - 待审/总数(徽标)
comments.get('/counts', async (c) => {
  const user = c.get('user')
  try {
    const row = await c.env.DB.prepare(
      `SELECT SUM(CASE WHEN cm.status = 'pending' THEN 1 ELSE 0 END) AS pending, COUNT(*) AS total
         FROM comments cm JOIN articles a ON a.id = cm.article_id WHERE a.user_id = ?`
    ).bind(user.id).first<{ pending: number; total: number }>()
    return ok({ pending: row?.pending || 0, total: row?.total || 0 })
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// POST /api/comments/:id/approve|reject - 改状态
async function updateStatus(c: any, st: string) {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('参数错误', 400)
  const row = await c.env.DB.prepare(
    `SELECT cm.id FROM comments cm JOIN articles a ON a.id = cm.article_id WHERE cm.id = ? AND a.user_id = ?`
  ).bind(id, user.id).first()
  if (!row) return err('评论不存在', 404)
  await c.env.DB.prepare('UPDATE comments SET status = ? WHERE id = ?').bind(st, id).run()
  return ok({ id, status: st })
}
comments.post('/:id/approve', (c) => updateStatus(c, 'approved'))
comments.post('/:id/reject', (c) => updateStatus(c, 'rejected'))

// POST /api/comments/:id/reply - 博主回复(自动通过,带 is_admin 标识,2 层夹取到被回复者所在楼)
comments.post('/:id/reply', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  try {
    const { content } = await c.req.json<{ content?: string }>()
    const text = (content || '').trim()
    if (!text) return err('回复内容不能为空', 400)
    if (text.length > 2000) return err('回复不超过 2000 字', 400)
    const row = await c.env.DB.prepare(
      `SELECT cm.id, cm.article_id, cm.root_id FROM comments cm JOIN articles a ON a.id = cm.article_id
        WHERE cm.id = ? AND a.user_id = ?`
    ).bind(id, user.id).first<{ id: number; article_id: number; root_id: number | null }>()
    if (!row) return err('评论不存在', 404)
    const { parent_id, root_id } = resolveThreadParent({ id: row.id, root_id: row.root_id })
    await c.env.DB.prepare(
      `INSERT INTO comments (article_id, parent_id, root_id, author_name, content, status, is_admin)
       VALUES (?, ?, ?, ?, ?, 'approved', 1)`
    ).bind(row.article_id, parent_id, root_id, user.username, text).run()
    return ok({ ok: true })
  } catch (e: any) {
    return err('回复失败: ' + e.message, 500)
  }
})

// DELETE /api/comments/:id
comments.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('参数错误', 400)
  const row = await c.env.DB.prepare(
    `SELECT cm.id FROM comments cm JOIN articles a ON a.id = cm.article_id WHERE cm.id = ? AND a.user_id = ?`
  ).bind(id, user.id).first()
  if (!row) return err('评论不存在', 404)
  await c.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run()
  return ok({ id })
})
