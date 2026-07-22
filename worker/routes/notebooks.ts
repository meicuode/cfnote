import { Hono } from 'hono'
import { ok, err } from '../utils'
import { deleteAttachmentsOf } from './files'
import type { AppEnv } from '../types'

export const notebooks = new Hono<AppEnv>()

// GET /api/notebooks - List user's notebooks
notebooks.get('/', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM notebooks WHERE user_id = ? ORDER BY updated_at DESC'
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取笔记本失败: ' + e.message, 500)
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
    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ?')
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

// DELETE /api/notebooks/:id - Delete notebook (cascade delete articles + vectors)
notebooks.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const notebook = await c.env.DB.prepare('SELECT * FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first()
    if (!notebook) return err('笔记本不存在', 404)

    // Get all vector IDs for articles in this notebook
    const { results: chunks } = await c.env.DB.prepare(
      'SELECT c.vector_id FROM chunks c INNER JOIN articles a ON c.article_id = a.id WHERE a.notebook_id = ?'
    ).bind(id).all<{ vector_id: string }>()

    // Delete vectors from Vectorize in batches
    if (chunks.length > 0) {
      const vectorIds = chunks.map((ch) => ch.vector_id)
      for (let i = 0; i < vectorIds.length; i += 100) {
        await c.env.VECTORIZE.deleteByIds(vectorIds.slice(i, i + 100))
      }
    }

    // 同步清理笔记本内所有文章引用的 R2 附件
    const { results: arts } = await c.env.DB.prepare(
      'SELECT content FROM articles WHERE notebook_id = ?'
    ).bind(id).all<{ content: string }>()
    await deleteAttachmentsOf(c.env, user.id, arts.map((a) => a.content || ''))

    // D1 cascade will handle articles and chunks
    await c.env.DB.prepare('DELETE FROM notebooks WHERE id = ?').bind(id).run()
    return ok({ message: '已删除' })
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
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(notebookId, user.id).first()
    if (!nb) return err('笔记本不存在', 404)

    const { results } = await c.env.DB.prepare(
      `SELECT id, notebook_id, title,
              SUBSTR(content, 1, 150) as summary,
              is_vectorized, created_at, updated_at
       FROM articles WHERE notebook_id = ? ORDER BY updated_at DESC`
    ).bind(notebookId).all()
    return ok(results)
  } catch (e: any) {
    return err('获取文章列表失败: ' + e.message, 500)
  }
})
