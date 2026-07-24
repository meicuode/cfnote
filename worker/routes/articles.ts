import { Hono } from 'hono'
import { ok, err, chunkText, contentHash, jinaReadUrl, trackEvent } from '../utils'
import { syncArticleFiles, purgeUnreferencedAttachments } from './files'
import { escapeLike } from './search'
import type { AppEnv } from '../types'
import type { Env } from '../../src/types'

export const articles = new Hono<AppEnv>()

// 标签规范化(P9):去空白、去重、上限 20 个、单个 ≤30 字符;空集存 NULL。
// 存 JSON 数组文本,查询用 SQLite json_each 展开,不建关联表。
function normalizeTags(input: unknown): string | null {
  if (!Array.isArray(input)) return null
  const seen = new Set<string>()
  for (const t of input) {
    if (seen.size >= 20) break
    const s = String(t).trim().slice(0, 30)
    if (s) seen.add(s)
  }
  return seen.size > 0 ? JSON.stringify([...seen]) : null
}

// 回收站 30 天自动清理(P9):打开回收站时懒执行 + cron 兜底。
// 附件按引用计数清理(与彻底删除同管线),失败静默下次重试。
export async function purgeExpiredTrash(env: Env): Promise<number> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, user_id, content FROM articles WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')"
    ).all<{ id: number; user_id: number; content: string }>()
    if (!results || results.length === 0) return 0
    const byUser = new Map<number, { ids: number[]; contents: string[] }>()
    for (const r of results) {
      const g = byUser.get(r.user_id) || { ids: [], contents: [] }
      g.ids.push(r.id)
      g.contents.push(r.content || '')
      byUser.set(r.user_id, g)
    }
    for (const [uid, g] of byUser) await purgeUnreferencedAttachments(env, uid, g.ids, g.contents)
    await env.DB.prepare(
      `DELETE FROM articles WHERE id IN (${results.map(() => '?').join(',')})`
    ).bind(...results.map((r) => r.id)).run()
    return results.length
  } catch {
    return 0
  }
}

// POST /api/articles - Create article
articles.post('/', async (c) => {
  const user = c.get('user')
  try {
    const { notebook_id, title, content, tags } = await c.req.json<{
      notebook_id: number; title: string; content: string; tags?: string[]
    }>()
    if (!notebook_id || !title?.trim()) return err('笔记本ID和标题不能为空')

    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(notebook_id, user.id).first()
    if (!nb) return err('笔记本不存在', 404)

    const hash = await contentHash(content || '')
    const result = await c.env.DB.prepare(
      'INSERT INTO articles (notebook_id, user_id, title, content, content_hash, tags) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(notebook_id, user.id, title.trim(), content || '', hash, normalizeTags(tags)).run()

    const articleId = result.meta.last_row_id

    await c.env.DB.prepare(
      'UPDATE notebooks SET article_count = article_count + 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(notebook_id).run()

    // 同步附件引用索引(内容为事实源,索引派生)
    await syncArticleFiles(c.env, user.id, articleId as number, content || '')

    let vectorize_error: string | null = null
    if (content && content.trim().length > 0) {
      vectorize_error = await vectorizeArticle(c.env, articleId as number, user.id, notebook_id, title.trim(), content)
    }

    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(articleId).first()
    return ok({ ...article as any, vectorize_error })
  } catch (e: any) {
    return err('创建失败: ' + e.message, 500)
  }
})

// POST /api/articles/import - Import article from URL via Jina Reader
articles.post('/import', async (c) => {
  const user = c.get('user')
  try {
    const { url, notebook_id } = await c.req.json<{ url: string; notebook_id: number }>()
    if (!url?.trim()) return err('URL 不能为空')
    if (!notebook_id) return err('请选择笔记本')

    // Verify notebook belongs to user
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(notebook_id, user.id).first()
    if (!nb) return err('笔记本不存在', 404)

    // Fetch article content via shared Jina Reader helper
    let articleTitle: string
    let articleContent: string
    try {
      const result = await jinaReadUrl(c.env, url)
      articleTitle = result.title
      articleContent = result.content
    } catch (e: any) {
      return err(e.message || '文章获取失败', 502)
    }

    if (!articleContent.trim()) {
      return err('未能从该页面提取到有效内容')
    }

    // Create article
    const hash = await contentHash(articleContent)
    const result = await c.env.DB.prepare(
      'INSERT INTO articles (notebook_id, user_id, title, content, content_hash) VALUES (?, ?, ?, ?, ?)'
    ).bind(notebook_id, user.id, articleTitle.trim(), articleContent, hash).run()

    const articleId = result.meta.last_row_id

    // Update notebook count
    await c.env.DB.prepare(
      'UPDATE notebooks SET article_count = article_count + 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(notebook_id).run()

    await syncArticleFiles(c.env, user.id, articleId as number, articleContent)

    // Vectorize
    let vectorize_error: string | null = null
    if (articleContent.trim().length > 0) {
      vectorize_error = await vectorizeArticle(c.env, articleId as number, user.id, notebook_id, articleTitle.trim(), articleContent)
    }

    // Fire-and-forget usage tracking
    trackEvent(c.env, 'import', user.id)

    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(articleId).first()
    return ok({ ...article as any, vectorize_error })
  } catch (e: any) {
    return err('导入失败: ' + e.message, 500)
  }
})

// GET /api/articles/private - 所有私有笔记(「我的私有」虚拟笔记本;须注册在 /:id 之前)
articles.get('/private', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, notebook_id, title,
              SUBSTR(content, 1, 150) as summary,
              is_vectorized, is_public, is_private, tags, pinned, created_at, updated_at
       FROM articles WHERE user_id = ? AND is_private = 1 AND deleted_at IS NULL
       ORDER BY pinned DESC, updated_at DESC`
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取私有笔记失败: ' + e.message, 500)
  }
})

// GET /api/articles/tags - 标签聚合(json_each 展开 JSON 列,不含回收站)
articles.get('/tags', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT je.value AS name, COUNT(*) AS count
       FROM articles a, json_each(COALESCE(a.tags, '[]')) je
       WHERE a.user_id = ? AND a.deleted_at IS NULL
       GROUP BY je.value ORDER BY count DESC, name`
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取标签失败: ' + e.message, 500)
  }
})

// GET /api/articles/by-tag?tag=xx - 按标签筛选(「标签」虚拟视图)
articles.get('/by-tag', async (c) => {
  const user = c.get('user')
  const tag = (c.req.query('tag') || '').trim()
  if (!tag) return err('缺少标签参数')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, notebook_id, title,
              SUBSTR(content, 1, 150) as summary,
              is_vectorized, is_public, is_private, tags, pinned, created_at, updated_at
       FROM articles a
       WHERE a.user_id = ? AND a.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM json_each(COALESCE(a.tags, '[]')) je WHERE je.value = ?)
       ORDER BY pinned DESC, updated_at DESC`
    ).bind(user.id, tag).all()
    return ok(results)
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/articles/trash - 回收站列表(顺带懒清理 30 天到期项)
articles.get('/trash', async (c) => {
  const user = c.get('user')
  try {
    await purgeExpiredTrash(c.env)
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.notebook_id, a.title,
              SUBSTR(a.content, 1, 150) as summary,
              a.is_vectorized, a.is_public, a.is_private, a.tags, a.pinned,
              a.deleted_at, a.created_at, a.updated_at, n.name AS notebook
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.user_id = ? AND a.deleted_at IS NOT NULL
       ORDER BY a.deleted_at DESC`
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取回收站失败: ' + e.message, 500)
  }
})

// POST /api/articles/trash/empty - 清空回收站(彻底删除全部,附件按引用计数清理)
articles.post('/trash/empty', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, content FROM articles WHERE user_id = ? AND deleted_at IS NOT NULL'
    ).bind(user.id).all<{ id: number; content: string }>()
    if (!results || results.length === 0) return ok({ purged: 0 })
    await purgeUnreferencedAttachments(c.env, user.id, results.map((r) => r.id), results.map((r) => r.content || ''))
    await c.env.DB.prepare(
      `DELETE FROM articles WHERE id IN (${results.map(() => '?').join(',')})`
    ).bind(...results.map((r) => r.id)).run()
    return ok({ purged: results.length })
  } catch (e: any) {
    return err('清空失败: ' + e.message, 500)
  }
})

// POST /api/articles/:id/restore - 从回收站恢复(重新计入笔记本,并重建向量索引)
articles.post('/:id/restore', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const article = await c.env.DB.prepare(
      'SELECT * FROM articles WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, user.id).first<any>()
    if (!article) return err('笔记不在回收站中', 404)

    // 原笔记本因外键级联通常仍在;防御性兜底:不在则落到最近使用的笔记本
    let targetNb = article.notebook_id
    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(targetNb, user.id).first()
    if (!nb) {
      const first = await c.env.DB.prepare(
        'SELECT id FROM notebooks WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1'
      ).bind(user.id).first<{ id: number }>()
      if (!first) return err('请先创建一个笔记本再恢复')
      targetNb = first.id
    }

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE articles SET deleted_at = NULL, notebook_id = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(targetNb, article.id),
      c.env.DB.prepare("UPDATE notebooks SET article_count = article_count + 1, updated_at = datetime('now') WHERE id = ?")
        .bind(targetNb),
    ])

    // 重建向量索引(软删除时已清):失败不阻塞恢复,可由 reindex 补
    let vectorize_error: string | null = null
    if ((article.content || '').trim().length > 0) {
      vectorize_error = await vectorizeArticle(c.env, article.id, user.id, targetNb, article.title, article.content)
    }
    const updated = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(article.id).first()
    return ok({ ...updated as any, vectorize_error })
  } catch (e: any) {
    return err('恢复失败: ' + e.message, 500)
  }
})

// DELETE /api/articles/:id/purge - 彻底删除回收站中的笔记(附件按引用计数清理)
articles.delete('/:id/purge', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const article = await c.env.DB.prepare(
      'SELECT id, content FROM articles WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL'
    ).bind(id, user.id).first<{ id: number; content: string }>()
    if (!article) return err('笔记不在回收站中', 404)
    await purgeUnreferencedAttachments(c.env, user.id, [article.id], [article.content || ''])
    await c.env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(article.id).run()
    return ok({ message: '已彻底删除' })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// GET /api/articles/titles?q= - 标题搜索(P9.2 笔记链接选择器;不含回收站)
articles.get('/titles', async (c) => {
  const user = c.get('user')
  const q = (c.req.query('q') || '').trim()
  try {
    let sql = `SELECT a.id, a.title, a.updated_at, n.name AS notebook
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.user_id = ? AND a.deleted_at IS NULL`
    const binds: unknown[] = [user.id]
    if (q) {
      sql += " AND a.title LIKE ? ESCAPE '\\'"
      binds.push(`%${escapeLike(q)}%`)
    }
    sql += ' ORDER BY a.updated_at DESC LIMIT 20'
    const { results } = await c.env.DB.prepare(sql).bind(...binds).all()
    return ok(results)
  } catch (e: any) {
    return err('搜索失败: ' + e.message, 500)
  }
})

// GET /api/articles/:id/backlinks - 反向链接(P9.2):内容含 (/?article=<id>) 深链的其他笔记。
// 链接格式固定为 [标题](/?article=<id>),右括号一并匹配避免 12 命中 123
articles.get('/:id/backlinks', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('参数不合法')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT id, title FROM articles
       WHERE user_id = ? AND deleted_at IS NULL AND id != ?
         AND instr(content, '?article=' || ? || ')') > 0
       ORDER BY updated_at DESC LIMIT 20`
    ).bind(user.id, id, String(id)).all()
    return ok(results)
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// ---- P9.3 笔记私密分享(unlisted):/blog/share/<token> 可看,不入博客列表/热榜。
// 与文件分享同构:token+过期两列即状态,单分享天然成立,重新生成即替换,取消置空。
// 私有笔记禁止分享;移入回收站/设为私有时自动撤销。

// POST /api/articles/:id/share {expires_in: 秒|null(永久)}
articles.post('/:id/share', async (c) => {
  const user = c.get('user')
  try {
    const { expires_in } = await c.req.json<{ expires_in?: number | null }>()
    if (expires_in != null && (!Number.isFinite(expires_in) || expires_in < 60 || expires_in > 10 * 366 * 86400)) {
      return err('有效期不合法')
    }
    const a = await c.env.DB.prepare('SELECT id, is_private, deleted_at FROM articles WHERE id = ? AND user_id = ?')
      .bind(c.req.param('id'), user.id).first<any>()
    if (!a) return err('文章不存在', 404)
    if (a.deleted_at) return err('回收站中的笔记不能分享')
    if (a.is_private) return err('私有笔记不能分享,请先取消私有')
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    const expiresAt = expires_in == null ? null : new Date(Date.now() + expires_in * 1000).toISOString()
    await c.env.DB.prepare('UPDATE articles SET share_token = ?, share_expires_at = ? WHERE id = ?')
      .bind(token, expiresAt, a.id).run()
    return ok({ token, share_expires_at: expiresAt, url: `/blog/share/${token}` })
  } catch (e: any) {
    return err('分享失败: ' + e.message, 500)
  }
})

// DELETE /api/articles/:id/share - 取消分享(链接立即失效)
articles.delete('/:id/share', async (c) => {
  const user = c.get('user')
  try {
    const r = await c.env.DB.prepare(
      'UPDATE articles SET share_token = NULL, share_expires_at = NULL WHERE id = ? AND user_id = ?'
    ).bind(c.req.param('id'), user.id).run()
    if (!r.meta.changes) return err('文章不存在', 404)
    return ok({ message: '已取消分享' })
  } catch (e: any) {
    return err('取消失败: ' + e.message, 500)
  }
})

// GET /api/articles/:id - Get article detail
articles.get('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first()
    if (!article) return err('文章不存在', 404)
    return ok(article)
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// PUT /api/articles/:id - Update article
articles.put('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const { title, content, notebook_id, is_public, is_private, tags, pinned } = await c.req.json<{
      title?: string; content?: string; notebook_id?: number
      is_public?: number | boolean; is_private?: number | boolean
      tags?: string[]; pinned?: number | boolean
    }>()

    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first<any>()
    if (!article) return err('文章不存在', 404)
    if (article.deleted_at) return err('回收站中的笔记为只读,请先恢复')

    // 公开/私有互斥:设为私有强制取消公开;公开要求先取消私有
    let pub = article.is_public ? 1 : 0
    let priv = article.is_private ? 1 : 0
    let publishedAt: string | null = article.published_at ?? null
    if (is_private !== undefined) {
      priv = is_private ? 1 : 0
      if (priv) pub = 0
    }
    if (is_public !== undefined) {
      if (is_public && priv) return err('私有笔记不能公开,请先取消私有')
      pub = is_public ? 1 : 0
      // 每次公开动作刷新发布时间(博客按发布时间排序展示)
      if (pub) publishedAt = new Date().toISOString().slice(0, 19).replace('T', ' ')
    }

    // If moving to another notebook, verify ownership
    if (notebook_id && notebook_id !== article.notebook_id) {
      const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?')
        .bind(notebook_id, user.id).first()
      if (!nb) return err('目标笔记本不存在', 404)
      await c.env.DB.batch([
        c.env.DB.prepare('UPDATE notebooks SET article_count = article_count - 1, updated_at = datetime(\'now\') WHERE id = ?').bind(article.notebook_id),
        c.env.DB.prepare('UPDATE notebooks SET article_count = article_count + 1, updated_at = datetime(\'now\') WHERE id = ?').bind(notebook_id),
      ])
    }

    const newTitle = title?.trim() || article.title
    const newContent = content ?? article.content
    const newNotebook = notebook_id || article.notebook_id
    const newHash = await contentHash(newContent)
    const newTags = tags === undefined ? (article.tags ?? null) : normalizeTags(tags)
    const newPinned = pinned === undefined ? (article.pinned ? 1 : 0) : (pinned ? 1 : 0)

    await c.env.DB.prepare(
      "UPDATE articles SET title = ?, content = ?, content_hash = ?, notebook_id = ?, is_public = ?, is_private = ?, published_at = ?, tags = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newTitle, newContent, newHash, newNotebook, pub, priv, publishedAt, newTags, newPinned, id).run()

    // 设为私有 → 撤销私密分享链接(私有笔记不可分享,不变式与文件分享一致)
    if (priv && article.share_token) {
      await c.env.DB.prepare('UPDATE articles SET share_token = NULL, share_expires_at = NULL WHERE id = ?').bind(id).run()
    }

    // 每次保存都同步附件引用索引(幂等,兼顾索引缺行的自愈)
    await syncArticleFiles(c.env, user.id, Number(id), newContent)

    // Re-vectorize if content changed
    let vectorize_error: string | null = null
    if (newHash !== article.content_hash) {
      // Delete old vectors and chunks
      const { results: oldChunks } = await c.env.DB.prepare('SELECT vector_id FROM chunks WHERE article_id = ?')
        .bind(id).all<{ vector_id: string }>()
      if (oldChunks.length > 0 && c.env.VECTORIZE) {
        try { await c.env.VECTORIZE.deleteByIds(oldChunks.map((ch) => ch.vector_id)) } catch {}
      }
      await c.env.DB.prepare('DELETE FROM chunks WHERE article_id = ?').bind(id).run()
      await c.env.DB.prepare('UPDATE articles SET is_vectorized = 0 WHERE id = ?').bind(id).run()

      if (newContent.trim().length > 0) {
        vectorize_error = await vectorizeArticle(c.env, Number(id), user.id, newNotebook, newTitle, newContent)
      }
    }

    const updated = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(id).first()
    return ok({ ...updated as any, vectorize_error })
  } catch (e: any) {
    return err('更新失败: ' + e.message, 500)
  }
})

// DELETE /api/articles/:id - 移入回收站(P9 软删除):向量与分块即刻清除(搜索/AI 不再可见),
// 同时取消公开与置顶;附件引用行保留(防共用附件被误清),30 天后自动彻底删除。
articles.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first<any>()
    if (!article) return err('文章不存在', 404)
    if (article.deleted_at) return err('已在回收站中')

    const { results: chunks } = await c.env.DB.prepare('SELECT vector_id FROM chunks WHERE article_id = ?')
      .bind(id).all<{ vector_id: string }>()
    if (chunks.length > 0 && c.env.VECTORIZE) {
      try { await c.env.VECTORIZE.deleteByIds(chunks.map((ch) => ch.vector_id)) } catch {}
    }

    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM chunks WHERE article_id = ?').bind(id),
      c.env.DB.prepare(
        "UPDATE articles SET deleted_at = datetime('now'), is_public = 0, pinned = 0, is_vectorized = 0, share_token = NULL, share_expires_at = NULL WHERE id = ?"
      ).bind(id),
      c.env.DB.prepare(
        "UPDATE notebooks SET article_count = article_count - 1, updated_at = datetime('now') WHERE id = ?"
      ).bind(article.notebook_id),
    ])

    return ok({ message: '已移入回收站,30 天后自动清除' })
  } catch (e: any) {
    return err('删除失败: ' + e.message, 500)
  }
})

// Helper: vectorize an article's content. Returns error message or null on success.
// userId is passed for usage logging.
export async function vectorizeArticle(
  env: Env, articleId: number, userId: number, notebookId: number, title: string, content: string,
): Promise<string | null> {
  try {
    const chunks = chunkText(title + '\n' + content)

    // Embed all chunks
    const embedResult: any = await env.AI.run('@cf/baai/bge-m3' as any, { text: chunks })

    // Workers AI embedding response: { shape: [n, dim], data: [[...], ...] }
    const vectors = embedResult?.data as number[][] | undefined

    if (!vectors || vectors.length === 0) {
      return `嵌入模型未返回向量数据, response keys: ${Object.keys(embedResult || {}).join(',')}`
    }

    if (vectors.length !== chunks.length) {
      return `向量数量(${vectors.length})与分块数量(${chunks.length})不匹配`
    }

    const dims = vectors[0].length
    if (dims === 0) {
      return '嵌入模型返回了空向量(0维)'
    }

    // Prepare Vectorize upsert and D1 chunk records
    const vectorEntries: VectorizeVector[] = []
    const chunkInserts: D1PreparedStatement[] = []

    for (let i = 0; i < chunks.length; i++) {
      const vectorId = `art_${articleId}_${i}`
      vectorEntries.push({
        id: vectorId,
        values: vectors[i],
        metadata: { article_id: articleId, notebook_id: notebookId, user_id: userId, chunk_index: i },
      })
      chunkInserts.push(
        env.DB.prepare('INSERT INTO chunks (article_id, chunk_index, chunk_text, vector_id) VALUES (?, ?, ?, ?)')
          .bind(articleId, i, chunks[i], vectorId)
      )
    }

    // Upsert vectors and check result
    const upsertResult = await env.VECTORIZE.upsert(vectorEntries)
    // Log upsert result for debugging
    console.log(`Vectorize upsert for article ${articleId}: ${JSON.stringify(upsertResult)}, dims=${dims}, chunks=${chunks.length}`)

    // Batch insert chunk records + mark article as vectorized
    await env.DB.batch([
      ...chunkInserts,
      env.DB.prepare('UPDATE articles SET is_vectorized = 1 WHERE id = ?').bind(articleId),
    ])

    // Fire-and-forget usage tracking
    trackEvent(env, 'vectorize', userId)

    return null
  } catch (e: any) {
    console.error('Vectorization failed for article', articleId, e)
    return '向量化失败: ' + (e.message || String(e))
  }
}
