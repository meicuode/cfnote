import { Hono } from 'hono'
import { ok, err, chunkText, contentHash, jinaReadUrl, trackEvent } from '../utils'
import type { AppEnv } from '../types'
import type { Env } from '../../src/types'

export const articles = new Hono<AppEnv>()

// POST /api/articles - Create article
articles.post('/', async (c) => {
  const user = c.get('user')
  try {
    const { notebook_id, title, content } = await c.req.json<{
      notebook_id: number; title: string; content: string
    }>()
    if (!notebook_id || !title?.trim()) return err('笔记本ID和标题不能为空')

    const nb = await c.env.DB.prepare('SELECT id FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(notebook_id, user.id).first()
    if (!nb) return err('笔记本不存在', 404)

    const hash = await contentHash(content || '')
    const result = await c.env.DB.prepare(
      'INSERT INTO articles (notebook_id, user_id, title, content, content_hash) VALUES (?, ?, ?, ?, ?)'
    ).bind(notebook_id, user.id, title.trim(), content || '', hash).run()

    const articleId = result.meta.last_row_id

    await c.env.DB.prepare(
      'UPDATE notebooks SET article_count = article_count + 1, updated_at = datetime(\'now\') WHERE id = ?'
    ).bind(notebook_id).run()

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
    const { title, content, notebook_id } = await c.req.json<{
      title?: string; content?: string; notebook_id?: number
    }>()

    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first<any>()
    if (!article) return err('文章不存在', 404)

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

    await c.env.DB.prepare(
      "UPDATE articles SET title = ?, content = ?, content_hash = ?, notebook_id = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newTitle, newContent, newHash, newNotebook, id).run()

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

// DELETE /api/articles/:id - Delete article
articles.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const article = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first<any>()
    if (!article) return err('文章不存在', 404)

    const { results: chunks } = await c.env.DB.prepare('SELECT vector_id FROM chunks WHERE article_id = ?')
      .bind(id).all<{ vector_id: string }>()
    if (chunks.length > 0 && c.env.VECTORIZE) {
      try { await c.env.VECTORIZE.deleteByIds(chunks.map((ch) => ch.vector_id)) } catch {}
    }

    await c.env.DB.prepare('DELETE FROM articles WHERE id = ?').bind(id).run()
    await c.env.DB.prepare(
      "UPDATE notebooks SET article_count = article_count - 1, updated_at = datetime('now') WHERE id = ?"
    ).bind(article.notebook_id).run()

    return ok({ message: '已删除' })
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
