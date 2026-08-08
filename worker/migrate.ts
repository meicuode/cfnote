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
  // P10.3:提醒已推送时间(防 cron 重发;设置/清除提醒时置 NULL 重新武装)
  reminded_at: 'ALTER TABLE articles ADD COLUMN reminded_at TEXT',
  // P13.4:单页(对标 WordPress 的「页面」)。仍是一篇公开笔记、URL 仍是 /blog/:id,
  // 区别只在**不进 loop**:列表、热榜、相关文章、上下篇、RSS 全部排除它。
  is_page: 'ALTER TABLE articles ADD COLUMN is_page INTEGER DEFAULT 0',
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

// P11.2 评论:访客评论表(旧库幂等补建;全新库由 system.ts SCHEMA 直接带出)
const COMMENTS_TABLE = `CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  parent_id INTEGER,
  root_id INTEGER,
  author_name TEXT NOT NULL,
  author_email TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  is_admin INTEGER DEFAULT 0,
  ip_hash TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
)`

// P11.9 评论来源:明文 IP 与 User-Agent(仅管理端可见)。旧库在评论表建出之后再补列。
const COMMENT_COLUMNS: Record<string, string> = {
  ip: 'ALTER TABLE comments ADD COLUMN ip TEXT',
  user_agent: 'ALTER TABLE comments ADD COLUMN user_agent TEXT',
}

// P14.1 笔记本软删除。此前删笔记本是硬删 + 外键 CASCADE,连带把 R2 上的附件也当场清了,
// 回收站里什么都留不下——整个知识库里唯一一处不可逆的破坏性操作。
// 加这一列之后就不必去动 articles 对 notebooks 的 ON DELETE CASCADE 外键(那要重建表,
// 违反「只做增量幂等」的约定):只要永远不 DELETE notebooks 那一行,CASCADE 就永远不会触发。
const NOTEBOOK_COLUMNS: Record<string, string> = {
  deleted_at: 'ALTER TABLE notebooks ADD COLUMN deleted_at TEXT',
  // P16.1 笔记本层级:NULL 表示挂在根上,所以老库天然就是一层平铺,零行为变化。
  // 同样不加外键约束(要重建表),父被删成孤儿由 src/lib/notebookTree 的 buildTree 兜底挂根。
  parent_id: 'ALTER TABLE notebooks ADD COLUMN parent_id INTEGER',
  // P16.5 的私密笔记本。这一批只建列不生效——跟 parent_id 一起加,省一次迁移往返
  is_private: 'ALTER TABLE notebooks ADD COLUMN is_private INTEGER DEFAULT 0',
}

// P16.9 JWT 吊销。签发时把这个值写进 token,鉴权时比对;改密码 +1,于是所有旧 token 当场失效。
//
// **退出登录不 bump**:你在手机上退出,不该把桌面也踢下线。只有改密码才表达
// 「断掉所有旧会话」这个意思——两者是不同的诉求,共用一个开关就没法只做前者。
//
// DEFAULT 0 让老库与老 token 天然对得上:老 token 里没有 epoch 字段,
// 读出来是 undefined,与 0 归一后相等,所以升级后不会把已登录的人全踢出去。
const USER_COLUMNS: Record<string, string> = {
  token_epoch: 'ALTER TABLE users ADD COLUMN token_epoch INTEGER DEFAULT 0',
  // P17.2 恢复码。忘了密码时唯一的自助出路——在此之前只能去 Cloudflare 控制台
  // 删掉 users 那一行再重新注册,而那要同时清 sqlite_sequence,否则新用户拿到 id=2、
  // 所有笔记还挂在 user_id=1 上,表现是「笔记全没了」。
  //
  // **明文存,而且刻意存在 users 表上**:buildExportPayload 导的是 notebooks/articles/
  // conversations/messages/settings/files/folders/comments/versions——没有 users 表。
  // 所以放这儿是结构性地不进备份,而不是靠「记得维护 SENSITIVE_PATTERNS 那条正则」;
  // 放 settings 里的话,key 名不含 key/token/secret 就会随每一份备份 JSON 下载到本地。
  //
  // 老库补出来是 NULL,由 /api/status 提示去设置里生成一个,不自动补——
  // 迁移里塞随机值意味着用户从不知道它存在,而这个码只有抄下来才有意义。
  recovery_code: 'ALTER TABLE users ADD COLUMN recovery_code TEXT',
}

// P18 待办模块。表建在这里(而不是只放 system.ts 的 SCHEMA)是因为老库不会再跑
// /api/init——P16.9.1 就是漏了这一处:列只加进 SCHEMA,已部署的库永远补不出来。
//
// 时间列一律 UTC ISO;tz_offset 存该条创建时的本地偏移分钟(UTC+8 = 480),
// 因为「工作日/自然周/自然月」是本地历法概念,按 UTC 数会差一天(见 src/lib/todoRules.ts)。
//
// overdue_reminds 与 reminded_at **必须是两个独立字段**:提前提醒推过之后
// reminded_at 就有值了,若拿它当「推过没有」的唯一依据,逾期提醒永远不会触发,
// 而且完全静默——到点之后再没有任何消息。
const TODO_TABLE = `CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  priority INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  due_at TEXT,
  remind_at TEXT,
  reminded_at TEXT,
  overdue_reminds INTEGER DEFAULT 0,
  lead_n INTEGER DEFAULT 0,
  lead_unit TEXT,
  repeat_n INTEGER DEFAULT 0,
  repeat_unit TEXT,
  tz_offset INTEGER DEFAULT 0,
  article_id INTEGER,
  completed_at TEXT,
  deleted_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
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
  // P11.2 评论表 + 索引(幂等)
  await env.DB.prepare(COMMENTS_TABLE).run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id, status, created_at)').run()
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at)').run()
  // P11.9 旧库补 ip/user_agent(全新库已由上方 CREATE 带出);必须在评论表建出之后
  const { results: cmtCols } = await env.DB.prepare('PRAGMA table_info(comments)').all<{ name: string }>()
  const cmtHave = new Set((cmtCols || []).map((r) => r.name))
  for (const [col, sql] of Object.entries(COMMENT_COLUMNS)) {
    if (!cmtHave.has(col)) await env.DB.prepare(sql).run()
  }
  // P14.1 笔记本软删除列(旧库补;全新库由 system.ts SCHEMA 直接带出)。
  // migrate.ts 从不建 notebooks 表(那是 /api/init 的事),只给已存在的表补列——
  // PRAGMA 对不存在的表返回 0 行而**不报错**,不判空就会直接撞上 "no such table";
  // 而 ensureSchema 的异常在 index.ts 里是被吞掉的,抛在这里会让它后面的步骤全部不执行。
  const { results: nbCols } = await env.DB.prepare('PRAGMA table_info(notebooks)').all<{ name: string }>()
  if (nbCols && nbCols.length > 0) {
    const nbHave = new Set(nbCols.map((r) => r.name))
    for (const [col, sql] of Object.entries(NOTEBOOK_COLUMNS)) {
      if (!nbHave.has(col)) await env.DB.prepare(sql).run()
    }
  }
  // P16.9 users 补 token_epoch。同上:PRAGMA 对不存在的表返回 0 行而不报错,必须判空。
  // **这一列缺失时鉴权会把所有人挡在外面**(查不到列 → 查询抛错 → fail closed),
  // 所以它必须在 ensureSchema 里,而不是等哪个接口第一次用到才建
  const { results: userCols } = await env.DB.prepare('PRAGMA table_info(users)').all<{ name: string }>()
  if (userCols && userCols.length > 0) {
    const userHave = new Set(userCols.map((r) => r.name))
    for (const [col, sql] of Object.entries(USER_COLUMNS)) {
      if (!userHave.has(col)) await env.DB.prepare(sql).run()
    }
  }
  // P18 待办表 + 两个索引(幂等)。
  // idx_todos_due 是 cron 每 5 分钟那次扫描走的索引:没有它就是全表扫,
  // 而待办会一直堆积(已完成的也留着),几个月后每 5 分钟扫一遍全表。
  await env.DB.prepare(TODO_TABLE).run()
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_todos_due ON todos(status, deleted_at, due_at, remind_at)'
  ).run()
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id, deleted_at, status, due_at)'
  ).run()
}
