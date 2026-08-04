import { Hono } from 'hono'
import { ok, err, chunkText, contentHash, jinaReadUrl, trackEvent } from '../utils'
import { syncArticleFiles, purgeUnreferencedAttachments, previewPurgeImpact } from './files'
import { escapeLike } from './search'
import { versionsToPrune } from '../../src/lib/versionRetention'
import { loadNotebookRows, shouldBePrivateIn, hasLiveNotebook } from '../notebookPrivacy'
import type { AppEnv } from '../types'
import type { Env } from '../../src/types'

export const articles = new Hono<AppEnv>()

// P10 版本历史:内容变更保存时快照一版。同小时合并(每篇每小时至多一版)在 SQL 侧判定,
// 保留策略(最近若干版全留 + 更早每日一版 + 硬上限)由 versionsToPrune 纯函数算出待删 id。
async function snapshotVersion(env: Env, userId: number, articleId: number, title: string, content: string, tags: string | null) {
  // 同小时已有版本 → 原地覆盖(合并),否则新插一行
  const sameHour = await env.DB.prepare(
    "SELECT id FROM article_versions WHERE article_id = ? AND strftime('%Y-%m-%d %H', created_at) = strftime('%Y-%m-%d %H', 'now') ORDER BY created_at DESC LIMIT 1"
  ).bind(articleId).first<{ id: number }>()
  if (sameHour) {
    await env.DB.prepare("UPDATE article_versions SET title = ?, content = ?, tags = ?, created_at = datetime('now') WHERE id = ?")
      .bind(title, content, tags, sameHour.id).run()
    return
  }
  await env.DB.prepare('INSERT INTO article_versions (article_id, user_id, title, content, tags) VALUES (?, ?, ?, ?, ?)')
    .bind(articleId, userId, title, content, tags).run()
  // 新插一版后做保留裁剪(仅每小时首版触发,开销小)
  const { results } = await env.DB.prepare('SELECT id, created_at FROM article_versions WHERE article_id = ? ORDER BY created_at DESC')
    .bind(articleId).all<{ id: number; created_at: string }>()
  const del = versionsToPrune(results || [])
  if (del.length > 0) {
    await env.DB.prepare(`DELETE FROM article_versions WHERE id IN (${del.map(() => '?').join(',')})`).bind(...del).run()
  }
}

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
// P14.1:同时清理超期的**笔记本**——先把它名下还在回收站的笔记连同附件清掉,
// 再删笔记本行。若这本已被恢复(deleted_at 为空)或名下还有活着的笔记,则一律不动。
export async function purgeExpiredTrash(env: Env): Promise<number> {
  try {
    const { results } = await env.DB.prepare(
      "SELECT id, user_id, content FROM articles WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')"
    ).all<{ id: number; user_id: number; content: string }>()
    if (results && results.length > 0) {
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
    }
    // 超期且名下已无任何文章的笔记本(此时外键 CASCADE 无事可做)
    await env.DB.prepare(
      `DELETE FROM notebooks WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', '-30 days')
         AND NOT EXISTS (SELECT 1 FROM articles WHERE notebook_id = notebooks.id)`
    ).run()
    return results ? results.length : 0
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

    // 笔记本存在性校验与「私密分支继承」合并成同一次全表取(个人库就几十行)。
    // 这条路覆盖了新建笔记、网页剪藏、AI 对话保存 —— 全都走 POST /api/articles
    const nbRows = await loadNotebookRows(c.env, user.id)
    if (!hasLiveNotebook(nbRows, notebook_id)) return err('笔记本不存在', 404)
    const priv = shouldBePrivateIn(nbRows, notebook_id) ? 1 : 0

    const hash = await contentHash(content || '')
    const result = await c.env.DB.prepare(
      'INSERT INTO articles (notebook_id, user_id, title, content, content_hash, tags, is_private) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(notebook_id, user.id, title.trim(), content || '', hash, normalizeTags(tags), priv).run()

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

    // Verify notebook belongs to user(顺带取到私密分支判断,P16.5)
    const nbRows = await loadNotebookRows(c.env, user.id)
    if (!hasLiveNotebook(nbRows, notebook_id)) return err('笔记本不存在', 404)
    const priv = shouldBePrivateIn(nbRows, notebook_id) ? 1 : 0

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
      'INSERT INTO articles (notebook_id, user_id, title, content, content_hash, is_private) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(notebook_id, user.id, articleTitle.trim(), articleContent, hash, priv).run()

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

// GET /api/articles/published - 所有已公开(博客)文章;博客管理视图用。
// 可选 q 标题搜索 + notebook_id 过滤 + kind=post|page 过滤(P13.4)(须注册在 /:id 之前)
articles.get('/published', async (c) => {
  const user = c.get('user')
  try {
    const q = (c.req.query('q') || '').trim()
    const nbId = Number(c.req.query('notebook_id'))
    const kind = c.req.query('kind')
    const conds = ['a.user_id = ?', 'a.is_public = 1', 'a.is_private = 0', 'a.deleted_at IS NULL']
    const binds: any[] = [user.id]
    if (q) { conds.push('a.title LIKE ?'); binds.push(`%${q}%`) }
    if (Number.isInteger(nbId) && nbId > 0) { conds.push('a.notebook_id = ?'); binds.push(nbId) }
    if (kind === 'page') conds.push('COALESCE(a.is_page, 0) = 1')
    else if (kind === 'post') conds.push('COALESCE(a.is_page, 0) = 0')
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.notebook_id, n.name AS notebook, a.title,
              SUBSTR(a.content, 1, 150) AS summary,
              a.published_at, a.updated_at, a.views, a.tags, COALESCE(a.is_page, 0) AS is_page
         FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
        WHERE ${conds.join(' AND ')}
        ORDER BY a.updated_at DESC
        LIMIT 500`
    ).bind(...binds).all()
    return ok(results)
  } catch (e: any) {
    return err('获取已公开文章失败: ' + e.message, 500)
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

// GET /api/articles/reminders - 提醒列表(P10;设了提醒时间且未删除的笔记,按时间升序)
articles.get('/reminders', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT a.id, a.title, a.remind_at, n.name AS notebook
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
       WHERE a.user_id = ? AND a.remind_at IS NOT NULL AND a.deleted_at IS NULL
       ORDER BY a.remind_at ASC`
    ).bind(user.id).all()
    return ok(results)
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})


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

// GET /api/articles/trash/impact - 清空回收站会连带清掉多少附件(P14.1,只读预检)
//
// 只在用户真的点了「清空」、确认框弹出时才请求一次——不占首屏,也不为此常驻一个统计。
// 「附件跟着一起删」这件事必须在按下不可逆按钮之前看得见,不能等按完了才发现图没了。
articles.get('/trash/impact', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, content FROM articles WHERE user_id = ? AND deleted_at IS NOT NULL'
    ).bind(user.id).all<{ id: number; content: string }>()
    const rows = results || []
    const impact = await previewPurgeImpact(c.env, user.id, rows.map((r) => r.id), rows.map((r) => r.content || ''))
    const nb = await c.env.DB.prepare(
      'SELECT COUNT(*) AS c FROM notebooks WHERE user_id = ? AND deleted_at IS NOT NULL'
    ).bind(user.id).first<{ c: number }>()
    return ok({ articles: rows.length, notebooks: nb?.c || 0, files: impact.files, bytes: impact.bytes })
  } catch (e: any) {
    return err('预检失败: ' + e.message, 500)
  }
})

// POST /api/articles/trash/empty - 清空回收站(彻底删除全部,附件按引用计数清理)
articles.post('/trash/empty', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, content FROM articles WHERE user_id = ? AND deleted_at IS NOT NULL'
    ).bind(user.id).all<{ id: number; content: string }>()
    const rows = results || []
    if (rows.length > 0) {
      await purgeUnreferencedAttachments(c.env, user.id, rows.map((r) => r.id), rows.map((r) => r.content || ''))
      await c.env.DB.prepare(
        `DELETE FROM articles WHERE id IN (${rows.map(() => '?').join(',')})`
      ).bind(...rows.map((r) => r.id)).run()
    }
    // P14.1:回收站里的笔记本一并清掉(此时名下已无文章,CASCADE 无事可做)
    const nb = await c.env.DB.prepare(
      `DELETE FROM notebooks WHERE user_id = ? AND deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM articles WHERE notebook_id = notebooks.id)`
    ).bind(user.id).run()
    return ok({ purged: rows.length, notebooks: nb.meta?.changes ?? 0 })
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

    // 原笔记本可能也在回收站里(P14.1 整本删除)——那就**连带把它一起恢复**。
    // 否则会出现「笔记本已删、里面却有活笔记」的矛盾态:侧栏看不到这本,笔记也就无处可去。
    // 笔记本被彻底删掉(旧数据/极端情况)才落到最近使用的那本。
    let targetNb = article.notebook_id
    let restoredNotebook: string | null = null
    const nb = await c.env.DB.prepare('SELECT id, name, deleted_at FROM notebooks WHERE id = ? AND user_id = ?')
      .bind(targetNb, user.id).first<{ id: number; name: string; deleted_at: string | null }>()
    if (!nb) {
      const first = await c.env.DB.prepare(
        'SELECT id FROM notebooks WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1'
      ).bind(user.id).first<{ id: number }>()
      if (!first) return err('请先创建一个笔记本再恢复')
      targetNb = first.id
    } else if (nb.deleted_at) {
      await c.env.DB.prepare("UPDATE notebooks SET deleted_at = NULL, updated_at = datetime('now') WHERE id = ?")
        .bind(nb.id).run()
      restoredNotebook = nb.name
    }

    // P16.5.3:恢复也要过私密不变式。软删除刻意不清 is_private,但**回收站里的笔记
    // 躲得过那道不变式**——PUT /api/notebooks/:id 拉平时只扫 deleted_at IS NULL。
    // 于是「删掉一篇公开笔记 → 把它的笔记本设为私密 → 恢复」就能让一篇非私有笔记
    // 落回私密支里,而你以为整棵是锁着的。恢复目标在私密分支就强制上锁。
    const privRows = await loadNotebookRows(c.env, user.id)
    const forcePriv = shouldBePrivateIn(privRows, targetNb)

    await c.env.DB.batch([
      forcePriv
        ? c.env.DB.prepare(
            `UPDATE articles SET deleted_at = NULL, notebook_id = ?, is_private = 1, is_public = 0,
                    share_token = NULL, share_expires_at = NULL, updated_at = datetime('now') WHERE id = ?`
          ).bind(targetNb, article.id)
        : c.env.DB.prepare("UPDATE articles SET deleted_at = NULL, notebook_id = ?, updated_at = datetime('now') WHERE id = ?")
            .bind(targetNb, article.id),
      c.env.DB.prepare('UPDATE notebooks SET article_count = (SELECT COUNT(*) FROM articles WHERE notebook_id = ? AND deleted_at IS NULL) WHERE id = ?')
        .bind(targetNb, targetNb),
    ])

    // 重建向量索引(软删除时已清):失败不阻塞恢复,可由 reindex 补
    let vectorize_error: string | null = null
    if ((article.content || '').trim().length > 0) {
      vectorize_error = await vectorizeArticle(c.env, article.id, user.id, targetNb, article.title, article.content)
    }
    const updated = await c.env.DB.prepare('SELECT * FROM articles WHERE id = ?').bind(article.id).first()
    return ok({ ...updated as any, vectorize_error, restored_notebook: restoredNotebook })
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

// PUT /api/articles/:id/reminder - 设置/清除提醒时间(P10;body {remind_at: ISO 字符串 | null})
articles.put('/:id/reminder', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const { remind_at } = await c.req.json<{ remind_at?: string | null }>()
    const article = await c.env.DB.prepare('SELECT id, deleted_at FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first<any>()
    if (!article) return err('文章不存在', 404)
    if (article.deleted_at) return err('回收站中的笔记不可设置提醒,请先恢复')
    let value: string | null = null
    if (remind_at) {
      const t = new Date(remind_at)
      if (isNaN(t.getTime())) return err('提醒时间格式无效')
      value = t.toISOString()
    }
    await c.env.DB.prepare('UPDATE articles SET remind_at = ?, reminded_at = NULL WHERE id = ?').bind(value, id).run()
    return ok({ id: Number(id), remind_at: value })
  } catch (e: any) {
    return err('设置失败: ' + e.message, 500)
  }
})

// GET /api/articles/:id/versions - 版本列表(P10;仅元信息,不含正文)
articles.get('/:id/versions', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  try {
    const article = await c.env.DB.prepare('SELECT id FROM articles WHERE id = ? AND user_id = ?')
      .bind(id, user.id).first()
    if (!article) return err('文章不存在', 404)
    const { results } = await c.env.DB.prepare(
      'SELECT id, title, length(content) AS chars, created_at FROM article_versions WHERE article_id = ? ORDER BY created_at DESC'
    ).bind(id).all()
    return ok(results || [])
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})

// GET /api/articles/:id/versions/:vid - 单个版本全文(P10,用于预览/恢复)
articles.get('/:id/versions/:vid', async (c) => {
  const user = c.get('user')
  const id = c.req.param('id')
  const vid = c.req.param('vid')
  try {
    const v = await c.env.DB.prepare(
      `SELECT v.id, v.title, v.content, v.tags, v.created_at
         FROM article_versions v JOIN articles a ON a.id = v.article_id
        WHERE v.id = ? AND v.article_id = ? AND a.user_id = ?`
    ).bind(vid, id, user.id).first()
    if (!v) return err('版本不存在', 404)
    return ok(v)
  } catch (e: any) {
    return err('获取失败: ' + e.message, 500)
  }
})


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
    const { title, content, notebook_id, is_public, is_private, is_page, tags, pinned } = await c.req.json<{
      title?: string; content?: string; notebook_id?: number
      is_public?: number | boolean; is_private?: number | boolean; is_page?: number | boolean
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

    // 单页(P13.4):与 is_public 正交——它不改变「能不能访问」,只决定「是否进文章流」。
    // 取消公开时不清 is_page:重新公开后它还该是单页,而不是悄悄变回一篇普通文章。
    const page = is_page === undefined ? (article.is_page ? 1 : 0) : (is_page ? 1 : 0)

    // If moving to another notebook, verify ownership
    if (notebook_id && notebook_id !== article.notebook_id) {
      const nbRows = await loadNotebookRows(c.env, user.id)
      if (!hasLiveNotebook(nbRows, notebook_id)) return err('目标笔记本不存在', 404)
      // P16.5:挪进私密分支就自动上锁(安全方向)。挪出去**不解锁**——
      // 不能因为拖错地方就把一篇私有笔记暴露出去。请求里显式带了 is_private 的以它为准
      if (is_private === undefined && shouldBePrivateIn(nbRows, notebook_id)) {
        priv = 1
        pub = 0
      }
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
      "UPDATE articles SET title = ?, content = ?, content_hash = ?, notebook_id = ?, is_public = ?, is_private = ?, is_page = ?, published_at = ?, tags = ?, pinned = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(newTitle, newContent, newHash, newNotebook, pub, priv, page, publishedAt, newTags, newPinned, id).run()

    // 设为私有 → 撤销私密分享链接(私有笔记不可分享,不变式与文件分享一致)
    if (priv && article.share_token) {
      await c.env.DB.prepare('UPDATE articles SET share_token = NULL, share_expires_at = NULL WHERE id = ?').bind(id).run()
    }

    // 每次保存都同步附件引用索引(幂等,兼顾索引缺行的自愈)
    await syncArticleFiles(c.env, user.id, Number(id), newContent)

    // Re-vectorize if content changed
    let vectorize_error: string | null = null
    if (newHash !== article.content_hash) {
      // P10 版本历史:内容有变则快照当前提交(同小时合并 + 保留裁剪)
      try { await snapshotVersion(c.env, user.id, Number(id), newTitle, newContent, newTags) } catch {}

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
        "UPDATE articles SET deleted_at = datetime('now'), is_public = 0, pinned = 0, is_vectorized = 0, share_token = NULL, share_expires_at = NULL, remind_at = NULL WHERE id = ?"
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
