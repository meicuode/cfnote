import { Hono } from 'hono'
import { ok, err, isAllowedModel, DEFAULT_MODEL, contentHash, logSystem } from '../utils'
import { vectorizeArticle } from './articles'
import type { AppEnv } from '../types'

export const system = new Hono<AppEnv>()

// 数据库表结构的唯一来源:修改表结构直接改这里,通过 POST /api/init 应用(全部 IF NOT EXISTS,可重复执行)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#10B981',
  article_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notebook_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  is_vectorized INTEGER DEFAULT 0,
  is_public INTEGER DEFAULT 0,
  is_private INTEGER DEFAULT 0,
  published_at TEXT,
  views INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  vector_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_articles_notebook ON articles(notebook_id);
CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id);
CREATE INDEX IF NOT EXISTS idx_chunks_article ON chunks(article_id);
CREATE INDEX IF NOT EXISTS idx_notebooks_user ON notebooks(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  sources TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_system_logs_level_time ON system_logs(level, created_at);

CREATE TABLE IF NOT EXISTS usage_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  action TEXT NOT NULL,
  model TEXT DEFAULT '',
  count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(period, action, model)
);
`

// GET /api/status - Check if system is initialized
system.get('/status', async (c) => {
  // jwt_secret_configured 仅暴露"是否已配置"布尔值,用于部署自检,不泄露任何密钥信息
  const jwtOk = !!c.env.JWT_SECRET
  try {
    const result = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).first()
    if (!result) {
      return ok({ initialized: false, hasUser: false, jwt_secret_configured: jwtOk })
    }
    const userCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>()
    return ok({ initialized: true, hasUser: (userCount?.count ?? 0) > 0, jwt_secret_configured: jwtOk })
  } catch {
    return ok({ initialized: false, hasUser: false, jwt_secret_configured: jwtOk })
  }
})

// POST /api/init - Initialize database tables
system.post('/init', async (c) => {
  try {
    const statements = SCHEMA.split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)

    for (const sql of statements) {
      await c.env.DB.prepare(sql).run()
    }

    return ok({ message: '数据库初始化成功' })
  } catch (e: any) {
    return err('初始化失败: ' + e.message, 500)
  }
})

// ---- Settings ----

const SENSITIVE_PATTERNS = /key|token|secret/i
const MASK_PREFIX = '****'

function maskValue(key: string, value: string): string {
  if (!SENSITIVE_PATTERNS.test(key) || !value) return value
  if (value.length <= 4) return MASK_PREFIX
  return MASK_PREFIX + value.slice(-4)
}

function isMasked(value: string): boolean {
  return value.startsWith(MASK_PREFIX)
}

// GET /api/settings - Get all settings as key-value object (sensitive values masked)
system.get('/settings', async (c) => {
  try {
    const rows = await c.env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
    const settings: Record<string, string> = {}
    for (const r of rows.results ?? []) {
      settings[r.key] = maskValue(r.key, r.value)
    }
    // Ensure llm_model always has a value
    if (!settings.llm_model) {
      settings.llm_model = DEFAULT_MODEL
    }
    return ok(settings)
  } catch (e: any) {
    return err('获取设置失败: ' + e.message, 500)
  }
})

// PUT /api/settings - Batch update settings (skip masked values)
system.put('/settings', async (c) => {
  try {
    const body = await c.req.json<Record<string, string>>()

    // Validate llm_model if present
    if (body.llm_model !== undefined && !isAllowedModel(body.llm_model)) {
      return err('不支持的模型')
    }

    for (const [key, value] of Object.entries(body)) {
      // Skip masked values — user didn't change the key
      if (isMasked(value)) continue

      await c.env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, value).run()
    }

    return ok(body)
  } catch (e: any) {
    return err('更新设置失败: ' + e.message, 500)
  }
})

// ---- Export ----

// GET /api/export - 全量数据备份(JSON 附件下载;敏感设置不导出)
system.get('/export', async (c) => {
  const user = c.get('user')
  try {
    const [notebooks, articles, convs, msgs, settingsRows] = await Promise.all([
      c.env.DB.prepare('SELECT id, name, description, color, created_at, updated_at FROM notebooks WHERE user_id = ? ORDER BY id').bind(user.id).all(),
      c.env.DB.prepare('SELECT id, notebook_id, title, content, created_at, updated_at FROM articles WHERE user_id = ? ORDER BY id').bind(user.id).all(),
      c.env.DB.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY id').bind(user.id).all(),
      c.env.DB.prepare('SELECT m.id, m.conversation_id, m.role, m.content, m.sources, m.created_at FROM messages m JOIN conversations cv ON m.conversation_id = cv.id WHERE cv.user_id = ? ORDER BY m.id').bind(user.id).all(),
      c.env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>(),
    ])

    const settings: Record<string, string> = {}
    for (const r of settingsRows.results ?? []) {
      if (SENSITIVE_PATTERNS.test(r.key)) continue
      settings[r.key] = r.value
    }

    const payload = {
      app: 'cfnote',
      export_version: 1,
      exported_at: new Date().toISOString(),
      username: user.username,
      notebooks: notebooks.results ?? [],
      articles: articles.results ?? [],
      conversations: convs.results ?? [],
      messages: (msgs.results ?? []).map((m: any) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : null })),
      settings,
    }

    const date = new Date().toISOString().slice(0, 10)
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="cfnote-export-${date}.json"`,
      },
    })
  } catch (e: any) {
    return err('导出失败: ' + e.message, 500)
  }
})

// POST /api/import - 导入备份(JSON):合并式导入笔记本与文章。
// 同名笔记本复用;同标题+同内容的文章跳过(可重复导入不产生重复数据)。
// 文章先以未向量化状态入库(避免单请求内大量 AI 调用超限),由前端随后分批调用 /api/reindex 补向量。
system.post('/import', async (c) => {
  const user = c.get('user')
  try {
    const data = await c.req.json<any>()
    if (data?.app !== 'cfnote' || !Array.isArray(data.notebooks) || !Array.isArray(data.articles)) {
      return err('文件格式不正确：请选择 CFNote 导出的 JSON 备份文件')
    }

    // 1. 笔记本:同名复用,否则创建(单条 batch 完成全部插入)
    const { results: existingNbs } = await c.env.DB.prepare(
      'SELECT id, name FROM notebooks WHERE user_id = ?'
    ).bind(user.id).all<{ id: number; name: string }>()
    const nbByName = new Map(existingNbs.map((n) => [n.name, n.id]))

    const nbMap = new Map<number, number>() // 备份中的 id -> 本库 id
    const toCreate: { oldId: number; name: string }[] = []
    for (const nb of data.notebooks) {
      if (typeof nb?.name !== 'string' || !nb.name) continue
      const existed = nbByName.get(nb.name)
      if (existed) nbMap.set(nb.id, existed)
      else toCreate.push({ oldId: nb.id, name: nb.name })
    }
    if (toCreate.length > 0) {
      const created = await c.env.DB.batch(toCreate.map((nb) =>
        c.env.DB.prepare('INSERT INTO notebooks (user_id, name) VALUES (?, ?)').bind(user.id, nb.name)
      ))
      created.forEach((r, i) => nbMap.set(toCreate[i].oldId, r.meta.last_row_id as number))
    }

    // 2. 文章:按 标题+内容哈希 去重后批量插入(未向量化)
    const { results: existingArts } = await c.env.DB.prepare(
      'SELECT title, content_hash FROM articles WHERE user_id = ?'
    ).bind(user.id).all<{ title: string; content_hash: string }>()
    const existingKeys = new Set(existingArts.map((a) => `${a.title} ${a.content_hash}`))

    const inserts: D1PreparedStatement[] = []
    let skipped = 0
    for (const a of data.articles) {
      const nbId = nbMap.get(a?.notebook_id)
      if (!nbId || typeof a?.title !== 'string' || !a.title) { skipped++; continue }
      const content = typeof a.content === 'string' ? a.content : ''
      const hash = await contentHash(content)
      const key = `${a.title} ${hash}`
      if (existingKeys.has(key)) { skipped++; continue }
      existingKeys.add(key)
      inserts.push(c.env.DB.prepare(
        'INSERT INTO articles (notebook_id, user_id, title, content, content_hash, is_vectorized) VALUES (?, ?, ?, ?, ?, 0)'
      ).bind(nbId, user.id, a.title, content, hash))
    }
    if (inserts.length > 0) {
      await c.env.DB.batch(inserts)
      await c.env.DB.prepare(
        "UPDATE notebooks SET article_count = (SELECT COUNT(*) FROM articles WHERE notebook_id = notebooks.id), updated_at = datetime('now') WHERE user_id = ?"
      ).bind(user.id).run()
    }

    logSystem(c.env, 'info', 'import', '备份导入完成', {
      notebooks_created: toCreate.length, articles_imported: inserts.length, articles_skipped: skipped,
    })
    return ok({
      notebooks_created: toCreate.length,
      articles_imported: inserts.length,
      articles_skipped: skipped,
    })
  } catch (e: any) {
    return err('导入失败: ' + e.message, 500)
  }
})

// POST /api/reindex - 为未向量化的文章补建向量,每次最多处理 3 篇,返回剩余数量。
// 前端循环调用直到 remaining 为 0(每篇一次嵌入调用,分批避免超单请求限制)。
system.post('/reindex', async (c) => {
  const user = c.get('user')
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT id, notebook_id, title, content FROM articles WHERE user_id = ? AND is_vectorized = 0 AND TRIM(content) != '' ORDER BY id LIMIT 3"
    ).bind(user.id).all<{ id: number; notebook_id: number; title: string; content: string }>()

    const errors: string[] = []
    for (const a of results) {
      const e = await vectorizeArticle(c.env, a.id, user.id, a.notebook_id, a.title, a.content)
      if (e) errors.push(`《${a.title}》: ${e}`)
    }

    const remaining = await c.env.DB.prepare(
      "SELECT COUNT(*) as cnt FROM articles WHERE user_id = ? AND is_vectorized = 0 AND TRIM(content) != ''"
    ).bind(user.id).first<{ cnt: number }>()

    return ok({ processed: results.length, remaining: remaining?.cnt ?? 0, errors })
  } catch (e: any) {
    return err('重建向量失败: ' + e.message, 500)
  }
})

// ---- System Logs ----

// GET /api/system-logs - Query system logs with pagination and filters
system.get('/system-logs', async (c) => {
  try {
    const level = c.req.query('level') || ''
    const source = c.req.query('source') || ''
    const limit = Math.min(Number(c.req.query('limit')) || 50, 200)
    const offset = Number(c.req.query('offset')) || 0

    let sql = 'SELECT * FROM system_logs WHERE 1=1'
    const binds: unknown[] = []

    if (level) {
      sql += ' AND level = ?'
      binds.push(level)
    }
    if (source) {
      sql += ' AND source = ?'
      binds.push(source)
    }

    // Count total
    const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as total')
    const countRow = await c.env.DB.prepare(countSql).bind(...binds).first<{ total: number }>()
    const total = countRow?.total ?? 0

    // Fetch page
    sql += ' ORDER BY id DESC LIMIT ? OFFSET ?'
    binds.push(limit, offset)
    const rows = await c.env.DB.prepare(sql).bind(...binds).all<any>()

    return ok({
      logs: rows.results ?? [],
      total,
      limit,
      offset,
    })
  } catch (e: any) {
    return err('获取日志失败: ' + e.message, 500)
  }
})

// DELETE /api/system-logs - Clean up logs older than 30 days
system.delete('/system-logs', async (c) => {
  try {
    const result = await c.env.DB.prepare(
      "DELETE FROM system_logs WHERE created_at < datetime('now', '-30 days')"
    ).run()
    return ok({ deleted: result.meta.changes ?? 0 })
  } catch (e: any) {
    return err('清理日志失败: ' + e.message, 500)
  }
})
