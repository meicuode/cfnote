import type { Env } from '../src/types'

// 应用内幂等 schema 保障(开发阶段约定:只做增量幂等语句——加列/建表;
// 若发生不兼容的表结构变更,不写迁移,直接提示用户线上清空并重新 /api/init)。
// 每个 isolate 首个 API 请求执行一次,之后 memoize 零开销;失败(表未初始化)下次请求重试。
const ARTICLE_COLUMNS: Record<string, string> = {
  is_public: 'ALTER TABLE articles ADD COLUMN is_public INTEGER DEFAULT 0',
  is_private: 'ALTER TABLE articles ADD COLUMN is_private INTEGER DEFAULT 0',
  published_at: 'ALTER TABLE articles ADD COLUMN published_at TEXT',
  views: 'ALTER TABLE articles ADD COLUMN views INTEGER DEFAULT 0',
}

// P8.1 附件体系三表(与 system.ts SCHEMA 保持一致;IF NOT EXISTS 幂等,对旧库是纯增量)
const FILE_TABLES = [
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    folder_id INTEGER,
    size INTEGER DEFAULT 0,
    content_type TEXT,
    category TEXT DEFAULT 'other',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    parent_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS article_files (
    article_id INTEGER NOT NULL,
    file_key TEXT NOT NULL,
    PRIMARY KEY (article_id, file_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_article_files_key ON article_files(file_key)',
]

let ensured: Promise<void> | null = null

export function ensureSchema(env: Env): Promise<void> {
  if (!ensured) {
    ensured = doEnsure(env).catch((e) => {
      ensured = null
      throw e
    })
  }
  return ensured
}

async function doEnsure(env: Env): Promise<void> {
  const { results } = await env.DB.prepare('PRAGMA table_info(articles)').all<{ name: string }>()
  const names = new Set((results || []).map((r) => r.name))
  if (names.size === 0) throw new Error('articles 表尚未创建(待 /api/init 初始化)')
  for (const [col, sql] of Object.entries(ARTICLE_COLUMNS)) {
    if (!names.has(col)) await env.DB.prepare(sql).run()
  }
  for (const sql of FILE_TABLES) await env.DB.prepare(sql).run()
}
