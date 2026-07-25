import type { Env } from '../src/types'

// 应用内幂等 schema 保障(开发阶段约定:只做增量幂等语句——加列/建表;
// 若发生不兼容的表结构变更,不写迁移,直接提示用户线上清空并重新 /api/init)。
// 每个 isolate 首个 API 请求执行一次,之后 memoize 零开销;失败(表未初始化)下次请求重试。
const ARTICLE_COLUMNS: Record<string, string> = {
  is_public: 'ALTER TABLE articles ADD COLUMN is_public INTEGER DEFAULT 0',
  is_private: 'ALTER TABLE articles ADD COLUMN is_private INTEGER DEFAULT 0',
  published_at: 'ALTER TABLE articles ADD COLUMN published_at TEXT',
  views: 'ALTER TABLE articles ADD COLUMN views INTEGER DEFAULT 0',
  // P9:回收站(软删除时间戳)/ 标签(JSON 数组文本,json_each 查询)/ 置顶
  deleted_at: 'ALTER TABLE articles ADD COLUMN deleted_at TEXT',
  tags: 'ALTER TABLE articles ADD COLUMN tags TEXT',
  pinned: 'ALTER TABLE articles ADD COLUMN pinned INTEGER DEFAULT 0',
  // P9.3:笔记私密分享链接(单分享,token+过期时间两列,与文件分享同构)
  share_token: 'ALTER TABLE articles ADD COLUMN share_token TEXT',
  share_expires_at: 'ALTER TABLE articles ADD COLUMN share_expires_at TEXT',
  // P10:应用内提醒时间(ISO UTC,NULL=无提醒;移入回收站自动清空)
  remind_at: 'ALTER TABLE articles ADD COLUMN remind_at TEXT',
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
    share_token TEXT,
    share_expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    parent_id INTEGER,
    is_private INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS article_files (
    article_id INTEGER NOT NULL,
    file_key TEXT NOT NULL,
    PRIMARY KEY (article_id, file_key)
  )`,
  'CREATE INDEX IF NOT EXISTS idx_article_files_key ON article_files(file_key)',
]

// P8.2 增强批:文件分享(单分享:token+过期时间两列)与私密文件夹标志。
// 对已建出三表的旧库补列;全新库由上方 CREATE 语句直接带列(见 EXTRA_COLUMNS 应用逻辑)。
const EXTRA_COLUMNS: { table: string; col: string; sql: string }[] = [
  { table: 'files', col: 'share_token', sql: 'ALTER TABLE files ADD COLUMN share_token TEXT' },
  { table: 'files', col: 'share_expires_at', sql: 'ALTER TABLE files ADD COLUMN share_expires_at TEXT' },
  { table: 'folders', col: 'is_private', sql: 'ALTER TABLE folders ADD COLUMN is_private INTEGER DEFAULT 0' },
]

let ensured: Promise<void> | null = null

// P10 版本历史:文章版本快照表(旧库幂等补建;全新库由 system.ts SCHEMA 直接带出)
const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
)`

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
  // 旧库补列(全新建表已直接带列):按表分组查一次 PRAGMA
  for (const table of [...new Set(EXTRA_COLUMNS.map((c) => c.table))]) {
    const { results: cols } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
    const have = new Set((cols || []).map((r) => r.name))
    for (const c of EXTRA_COLUMNS) {
      if (c.table === table && !have.has(c.col)) await env.DB.prepare(c.sql).run()
    }
  }
  // 分享 token 查询索引(列保证存在后建)
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_files_share ON files(share_token)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_articles_share ON articles(share_token)').run()
  // 版本历史表 + 索引(幂等)
  await env.DB.prepare(VERSION_TABLE).run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_article_versions ON article_versions(article_id, created_at)').run()
}
