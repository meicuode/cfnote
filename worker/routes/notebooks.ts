import { Hono } from 'hono'
import { ok, err } from '../utils'
import { purgeUnreferencedAttachments } from './files'
import { vectorizeArticle } from './articles'
import type { AppEnv } from '../types'

export const notebooks = new Hono<AppEnv>()

// GET /api/notebooks - List user's notebooks(不含回收站中的)
notebooks.get('/', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM notebooks WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC'
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取笔记本失败: ' + e.message, 500)
  }
})

// GET /api/notebooks/trash - 回收站中的笔记本(P14.1),附其中仍在回收站的笔记数
// 必须注册在 /:id 系列之前
notebooks.get('/trash', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT n.id, n.name, n.color, n.deleted_at,
              (SELECT COUNT(*) FROM articles a WHERE a.notebook_id = n.id AND a.deleted_at IS NOT NULL) AS article_count
       FROM notebooks n
       WHERE n.user_id = ? AND n.deleted_at IS NOT NULL
       ORDER BY n.deleted_at DESC`
    ).bind(user.id).all()
    return ok(results || [])
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// POST /api/notebooks - Create notebook
notebooks.post('/', async (c) => {
  const user = c.get('user')
  try {
    const { name, description, color } = await c.req.json<{ name: string; description?: string; color?: string }>()
    if (!name?.trim()) return err('笔记本名称不能为空')

    const result = await c.env.DB.prepare(
      'INSERT INTO notebooks (user_id, name, description, color) VALUES (?, ?, ?, ?)'
    ).bind(user.id, name.trim(), description || '', color || '#10B981').run()

    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ?')
      .bind(result.meta.last_row_id)
      .first()
    return ok(notebook)
  } catch (e: any) {
    return err('创建笔记本失败: ' + e.message, 500)
  }
})

// PUT /api/notebooks/:id - Update notebook
notebooks.put('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const { name, description, color } = await c.req.json<{ name?: string; description?: string; color?: string }>()
    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(id, user.id).first()
    if (!notebook) return err('笔记本不存在', 404)

    await c.env.DB.prepare(
      "UPDATE notebooks SET name = COALESCE(?, name), description = COALESCE(?, description), color = COALESCE(?, color), updated_at = datetime('now') WHERE id = ?"
    ).bind(name || null, description ?? null, color || null, id).run()

    const updated = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ?').bind(id).first()
    return ok(updated)
  } catch (e: any) {
    return err('更新失败: ' + e.message, 500)
  }
})

// DELETE /api/notebooks/:id - 移入回收站(P14.1 软删除)
//
// 此前这里是硬删:清向量 → **立即** purgeUnreferencedAttachments(R2 上的图当场没了)
// → DELETE FROM notebooks 靠外键 CASCADE 带走全部文章。一次误点,两百篇笔记连同附件一起消失,
// 回收站里什么都没有——这是整个知识库里唯一一处不可逆的破坏性操作。
//
// 现在改为:笔记本与其名下**仍活着**的笔记一起打 deleted_at,附件一个不动。
// 只要不 DELETE notebooks 那一行,CASCADE 就永远不会触发,因此**不必去改外键约束**
// (那要重建表,违反「只做增量幂等」的约定)。附件的清理推迟到彻底删除时,走与单篇一致的引用计数。
notebooks.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(id, user.id).first()
    if (!notebook) return err('笔记本不存在', 404)

    // 与单篇软删一致:向量与分块即刻清除,搜索/AI 立刻看不到(恢复时重建)
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT c.vector_id FROM chunks c INNER JOIN articles a ON c.article_id = a.id WHERE a.notebook_id = ? AND a.deleted_at IS NULL'
    ).bind(id).all<{ vector_id: string }>()
    if (chunks.length > 0 && c.env.VECTORIZE) {
      const vectorIds = chunks.map((ch) => ch.vector_id)
      for (let i = 0; i < vectorIds.length; i += 100) {
        try { await c.env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 100)) } catch { /* 静默,可由 reindex 补 */ }
      }
    }

    // 只碰仍活着的笔记:此前已单独删掉的那些各有各的 30 天倒计时,不该被重置
    const moved = await c.env.DB.prepare(
      `UPDATE articles SET deleted_at = datetime('now'), is_public = 0, pinned = 0, is_vectorized = 0,
              share_token = NULL, share_expires_at = NULL, remind_at = NULL
       WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NULL`
    ).bind(id, user.id).run()

    await c.env.DB.batch([
      c.env.DB.prepare(
        'DELETE FROM chunks WHERE article_id IN (SELECT id FROM articles WHERE notebook_id = ?)'
      ).bind(id),
      c.env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now'), article_count = 0 WHERE id = ?").bind(id),
    ])

    const count = moved.meta?.changes ?? 0
    return ok({ message: `已移入回收站(${count} 篇笔记),30 天后自动清除`, articles: count })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// POST /api/notebooks/:id/restore - 从回收站整本恢复(P14.1)
//
// 会**一并恢复它名下所有仍在回收站的笔记**,包括此前单独删掉的那几篇。
// 宁可多恢复(你再删一次就是了)也不要少恢复——否则得从两百篇里把属于这本的挑出来。
// 返回恢复数量,前端在确认框里明说。
notebooks.post('/:id/restore', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const nb = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .bind(id, user.id).first<any>()
    if (!nb) return err('笔记本不在回收站中', 404)

    const { results: arts } = await c.env.DB.prepare(
      'SELECT id, title, content FROM articles WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, user.id).all<{ id: number; title: string; content: string }>()

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE articles SET deleted_at = NULL, updated_at = datetime('now') WHERE notebook_id = ? AND user_id = ? AND deleted_at IS NOT NULL")
        .bind(id, user.id),
      c.env.DB.prepare("UPDATE notebooks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?").bind(id),
      c.env.DB.prepare('UPDATE notebooks SET article_count = (SELECT COUNT(*) FROM articles WHERE notebook_id = ? AND deleted_at IS NULL) WHERE id = ?')
        .bind(id, id),
    ])

    // 重建向量:逐篇失败不阻塞恢复(可由 /api/reindex 补)
    let failed = 0
    for (const a of arts || []) {
      if (!(a.content || '').trim()) continue
      const e = await vectorizeArticle(c.env, a.id, user.id, Number(id), a.title, a.content)
      if (e) failed++
    }
    return ok({ message: `已恢复「${nb.name}」`, articles: (arts || []).length, vectorize_failed: failed })
  } catch (e: any) {
    return err('恢复失败: ' + e.message, 500)
  }
})

// DELETE /api/notebooks/:id/purge - 彻底删除回收站中的笔记本(P14.1)
// 附件走与单篇彻底删除完全相同的引用计数管线,不另开规则。
notebooks.delete('/:id/purge', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL')
      .bind(id, user.id).first()
    if (!nb) return err('笔记本不在回收站中', 404)

    const { results: arts } = await c.env.DB.prepare(
      'SELECT id, content FROM articles WHERE notebook_id = ? AND user_id = ?'
    ).bind(id, user.id).all<{ id: number; content: string }>()
    const ids = (arts || []).map((a) => a.id)
    if (ids.length > 0) {
      await purgeUnreferencedAttachments(c.env, user.id, ids, (arts || []).map((a) => a.content || ''))
      await c.env.DB.prepare(`DELETE FROM articles WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run()
    }
    // 此时名下已无文章,CASCADE 无事可做
    await c.env.DB.prepare('DELETE FROM notebooks WHERE id = ?').bind(id).run()
    return ok({ message: '已彻底删除', articles: ids.length })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// GET /api/notebooks/:id/articles - List articles in a notebook
notebooks.get('/:id/articles', async (c) => {
  const user = c.get('user')
  const notebookId = c.req.param('id')
  try {
    // Verify notebook belongs to user
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .bind(notebookId, user.id).first()
    if (!nb) return err('笔记本不存在', 404)

    const { results } = await c.env.DB.prepare(
      `SELECT id, notebook_id, title,
              SUBSTR(content, 1, 150) as summary,
              is_vectorized, is_public, is_private, tags, pinned, created_at, updated_at
       FROM articles WHERE notebook_id = ? AND deleted_at IS NULL
       ORDER BY pinned DESC, updated_at DESC`
    ).bind(notebookId).all()
    return ok(results)
  } catch (e: any) {
    return err('获取文章列表失败: ' + e.message, 500)
  }
})
