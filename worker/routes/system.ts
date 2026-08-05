import { Hono } from 'hono'
import { ok, err, isAllowedModel, DEFAULT_MODEL, contentHash, logSystem, getUser } from '../utils'
import { vectorizeArticle } from './articles'
import { syncArticleFiles } from './files'
import { buildExportPayload, SENSITIVE_PATTERNS, CHANNELS_KEY } from '../backup'
import { MASK_PREFIX, maskChannels, mergeMaskedChannels, type NotifyChannel } from '../../src/lib/notifyChannels'
import { loadNotebookRows, shouldBePrivateIn } from '../notebookPrivacy'
import { pathOf } from '../../src/lib/notebookTree'
import type { AppEnv } from '../types'
import type { Env } from '../../src/types'

export const system = new Hono<AppEnv>()

// 数据库表结构的唯一来源:修改表结构直接改这里,通过 POST /api/init 应用(全部 IF NOT EXISTS,可重复执行)
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  token_epoch INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#10B981',
  article_count INTEGER DEFAULT 0,
  parent_id INTEGER,
  is_private INTEGER DEFAULT 0,
  deleted_at TEXT,
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
  is_page INTEGER DEFAULT 0,
  published_at TEXT,
  views INTEGER DEFAULT 0,
  deleted_at TEXT,
  tags TEXT,
  pinned INTEGER DEFAULT 0,
  share_token TEXT,
  share_expires_at TEXT,
  remind_at TEXT,
  reminded_at TEXT,
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

CREATE TABLE IF NOT EXISTS article_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (article_id) REFERENCES articles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_articles_notebook ON articles(notebook_id);
CREATE INDEX IF NOT EXISTS idx_articles_user ON articles(user_id);
CREATE INDEX IF NOT EXISTS idx_articles_share ON articles(share_token);
CREATE INDEX IF NOT EXISTS idx_chunks_article ON chunks(article_id);
CREATE INDEX IF NOT EXISTS idx_article_versions ON article_versions(article_id, created_at);
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

CREATE TABLE IF NOT EXISTS files (
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
);
CREATE INDEX IF NOT EXISTS idx_files_share ON files(share_token);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER,
  is_private INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS article_files (
  article_id INTEGER NOT NULL,
  file_key TEXT NOT NULL,
  PRIMARY KEY (article_id, file_key)
);
CREATE INDEX IF NOT EXISTS idx_article_files_key ON article_files(file_key);

CREATE TABLE IF NOT EXISTS comments (
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
);
CREATE INDEX IF NOT EXISTS idx_comments_article ON comments(article_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_status ON comments(status, created_at);
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
//
// 免鉴权(部署后第一件事就是它,那时还没有账号)。全套语句都是 IF NOT EXISTS,
// 所以对已初始化的库本来就是空操作、取不到也删不掉任何数据。
//
// 但**匿名调用不能无限次跑**:每次十几条 D1 语句,而请求数(10 万/天)是这个部署最紧的
// 额度,匿名可调等于给了一个免费放大器。所以已初始化 + 未登录 → 直接短路。
// **登录态照旧无条件重跑**:上面那句注释说的「改表结构直接改 SCHEMA、通过 /api/init
// 应用」是既定用法(加新表就靠它),不能因为防刷把这条路堵死。
system.post('/init', async (c) => {
  try {
    const inited = await c.env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
    ).first().catch(() => null)
    if (inited && !(await getUser(c.req.raw, c.env))) {
      return ok({ message: '数据库已初始化', already: true })
    }

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

// SENSITIVE_PATTERNS / CHANNELS_KEY 定义在 worker/backup.ts:
// 「哪些设置不能出现在备份里」和「哪些设置不能下发给前端」是同一份名单,
// 分两处写迟早只改其中一处。

// 掩码前缀与 notifyChannels 共用一个常量:两处各写一遍 '****' 迟早只改其中一处。
function maskValue(key: string, value: string): string {
  if (!SENSITIVE_PATTERNS.test(key) || !value) return value
  if (value.length <= 4) return MASK_PREFIX
  return MASK_PREFIX + value.slice(-4)
}

function isMasked(value: string): boolean {
  return value.startsWith(MASK_PREFIX)
}

function parseChannels(raw: string | null | undefined): NotifyChannel[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

/** 读库里已存的渠道配置(掩码合并时要拿回真值) */
async function storedChannels(env: Env): Promise<NotifyChannel[]> {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(CHANNELS_KEY).first<{ value: string }>()
  return parseChannels(row?.value)
}

// GET /api/settings - Get all settings as key-value object (sensitive values masked)
system.get('/settings', async (c) => {
  try {
    const rows = await c.env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
    const settings: Record<string, string> = {}
    for (const r of rows.results ?? []) {
      settings[r.key] = maskValue(r.key, r.value)
    }
    // notify_channels 是一整块 JSON,键名不匹配 SENSITIVE_PATTERNS,此前整块明文下发。
    // 逐字段掩码:token / sendkey / 加签密钥,以及企业微信、钉钉的 Webhook 地址(URL 本身就是凭据)。
    if (settings[CHANNELS_KEY]) {
      settings[CHANNELS_KEY] = JSON.stringify(maskChannels(parseChannels(settings[CHANNELS_KEY])))
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

      // 渠道配置不能整键跳过:同一份 JSON 里还有 enabled / chat_id 等确实要保存的改动,
      // 只把仍是掩码的凭据字段还原成库里的旧值。
      const toStore = key === CHANNELS_KEY
        ? JSON.stringify(mergeMaskedChannels(parseChannels(value), await storedChannels(c.env)))
        : value

      await c.env.DB.prepare(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, toStore).run()
    }

    return ok(body)
  } catch (e: any) {
    return err('更新设置失败: ' + e.message, 500)
  }
})

// ---- Export ----

// 可以从备份恢复的设置键(P12.11):只放行博客展示层的配置。
// 不含 site_url(换域名恢复会把 RSS/sitemap 里的绝对地址写错)、不含模型与任何敏感项。
export function isRestorableSetting(key: string): boolean {
  if (SENSITIVE_PATTERNS.test(key) || key === CHANNELS_KEY) return false
  return key.startsWith('blog_') || key.startsWith('comments_')
}

// GET /api/export - 全量数据备份(JSON 附件下载;敏感设置不导出)
// ?versions=1 额外带上文章的历史版本(每篇可能有几十版,体积会翻几倍,故默认不带)
// 快照的构建在 worker/backup.ts,与 R2 自动备份是同一份逻辑(P14.2)。
system.get('/export', async (c) => {
  const user = c.get('user')
  const withVersions = c.req.query('versions') === '1'
  try {
    const payload = await buildExportPayload(c.env, user, withVersions)
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

    // 1. 笔记本:**按完整路径**复用,否则创建(P16.3.1;此前是平铺按名字)
    //
    // 按名字匹配在树里是错的:不同分支可以有同名笔记本(`技术/归档` 与 `读书/归档`),
    // 会被并成一本,而且并进去的那本还带着另一支的层级与私密性。
    //
    // 路径键不能靠拼接分隔符:笔记本名字里可以有斜杠,
    // 用 `/` 连的话「叫 a/b 的根笔记本」和「a 下面的 b」会算成同一个键。（键的构造见下方 pathKey）
    //
    // **老备份(P16.8 之前没有 parent_id)天然退化为按名字匹配**——每条路径都只有一段,
    // 与改造前的行为逐字一致,所以不必为老文件另开一条分支。
    const { results: existingNbs } = await c.env.DB.prepare(
      'SELECT id, name, parent_id FROM notebooks WHERE user_id = ? AND deleted_at IS NULL'
    ).bind(user.id).all<{ id: number; name: string; parent_id: number | null }>()
    // **只看没在回收站里的**(P16.4):路径撞上一本已删的笔记本时,若复用它,
    // 导进来的笔记就直接躺进回收站——界面上等于凭空消失。这跟 loadNotebookRows
    // 刻意连已删的一起取是两回事:那边算的是私密继承(与死活无关),
    // 这边问的是「能不能往这儿写」,同 hasLiveNotebook 一个口径。
    // 活笔记本的祖先必然也活着(P16.3 删父级联、恢复带祖先壳),所以路径链不会断。
    const local = existingNbs || []
    // 路径键走 JSON.stringify(数组) 而不是拼接:笔记本名字里可以有任何字符(包括斜杠),
    // 挑不出一个「一定不会出现」的分隔符——那正是「叫 a/b 的根笔记本」和「a 下面的 b」
    // 会撞成同一个键的由来。JSON 自己负责转义,键还是纯 ASCII、能直接打印出来看
    const pathKey = (segs: string[]) => JSON.stringify(segs)
    const localByPath = new Map<string, number>()
    for (const n of local) {
      const k = pathKey(pathOf(local, n.id))
      // 同路径重复(同一层两个同名笔记本,应用是允许的)取先出现的那个,
      // 与此前「同名复用取第一个」保持一致
      if (!localByPath.has(k)) localByPath.set(k, n.id)
    }

    const backupNbs: { id: number; name: string; parent_id: number | null; description?: unknown; color?: unknown; is_private?: unknown }[] =
      (data.notebooks || [])
        .filter((n: any) => typeof n?.name === 'string' && n.name && typeof n?.id === 'number')
        .map((n: any) => ({ ...n, parent_id: typeof n.parent_id === 'number' ? n.parent_id : null }))

    const nbMap = new Map<number, number>() // 备份中的 id -> 本库 id
    const freshIds = new Set<number>() // 这次真新建出来的(路径已存在而复用的不算)
    const toCreate: { oldId: number; name: string; description: string; color: string; isPrivate: number }[] = []
    for (const nb of backupNbs) {
      const existed = localByPath.get(pathKey(pathOf(backupNbs, nb.id)))
      if (existed) nbMap.set(nb.id, existed)
      else toCreate.push({
        oldId: nb.id,
        name: nb.name,
        // P16.8:这三列备份里一直有,恢复侧却只写了 name——有笔记本设过颜色的话恢复出来全是默认绿
        description: typeof nb.description === 'string' ? nb.description : '',
        color: typeof nb.color === 'string' && nb.color ? nb.color : '#10B981',
        isPrivate: nb.is_private ? 1 : 0,
      })
    }
    if (toCreate.length > 0) {
      const created = await c.env.DB.batch(toCreate.map((nb) =>
        c.env.DB.prepare('INSERT INTO notebooks (user_id, name, description, color, is_private) VALUES (?, ?, ?, ?, ?)')
          .bind(user.id, nb.name, nb.description, nb.color, nb.isPrivate)
      ))
      created.forEach((r, i) => {
        const id = r.meta.last_row_id as number
        nbMap.set(toCreate[i].oldId, id)
        freshIds.add(id)
      })
    }

    // 1b. 回填 parent_id(第二遍)。备份里的 parent_id 是**备份自己的 id**,要过 nbMap 换成本库 id,
    // 而父本可能与子本同在上面那个 batch 里刚建出来、插入时还拿不到它的新 id——
    // 与 P12.11 重挂评论父子关系同一个两遍法。
    //
    // 只回填**这次新建的**:同名复用的笔记本在本库已经有自己的位置,不该被备份里的层级冲掉
    // (与「settings 只在当前没有该项时才恢复」同一条规矩——往一个已经配好的站里导备份,
    // 不该把人家现在的结构挪走)。同理复用的那些也不改 is_private:把一个现存笔记本悄悄设成私密,
    // 就会造出 P16.5.1 明令禁止的那个状态——笔记本挂着锁、里面老笔记全是敞的,
    // 而拉平整支需要 PUT /api/notebooks/:id 那套不变式机器,不是导入该顺手做的事。
    //
    // **必须排在下面 loadNotebookRows 之前**:私密沿祖先链继承,链还没接上就取表,
    // 子本里的笔记会被判成「不在私密分支」而漏锁。
    // 环(手改过的备份)不在这里挡:buildTree 与 inPrivateBranch 都带 seen 集合,
    // 就地打断成根且不会死循环,这是 P16.1 立的两条容错,不另立第二道。
    const reparent: D1PreparedStatement[] = []
    for (const nb of data.notebooks) {
      const mine = nbMap.get(nb?.id)
      if (mine === undefined || !freshIds.has(mine)) continue
      if (nb?.parent_id == null) continue
      const parent = nbMap.get(nb.parent_id)
      if (parent === undefined || parent === mine) continue
      reparent.push(c.env.DB.prepare('UPDATE notebooks SET parent_id = ? WHERE id = ? AND user_id = ?')
        .bind(parent, mine, user.id))
    }
    if (reparent.length > 0) await c.env.DB.batch(reparent)

    // 2. 文章:按 标题+内容哈希 去重后批量插入(未向量化)
    // 笔记本表在上一步可能新建过行,私密分支判断必须放在那之后取(P16.5),整批只取一次
    const privRows = await loadNotebookRows(c.env, user.id)
    const { results: existingArts } = await c.env.DB.prepare(
      'SELECT id, notebook_id, title, content_hash FROM articles WHERE user_id = ?'
    ).bind(user.id).all<{ id: number; notebook_id: number; title: string; content_hash: string }>()
    // 去重键 = 笔记本 + 标题 + 内容哈希。**笔记本这一项是 P16.4 补的**:
    // 在此之前是纯「标题 + 哈希」,而文件夹导入把目录建成笔记本树之后,标题从
    // `技术/README` 变回了 `README`——每个子目录各放一份一模一样的 README.md 时,
    // 第一份进库,其余全被判重跳过,那是真丢数据(importTitle.ts 顶上那段注释警告的就是这个)。
    //
    // 代价是导出后把某篇挪了个笔记本、再导入,会多出一份而不是被认出来。
    // 「静默少一篇」比「看得见的重复一篇」坏得多,取后者。
    const artKey = (nbId: number, title: string, hash: string) => JSON.stringify([nbId, title, hash])
    // 值是本库文章 id:评论要按「备份里的 article_id → 本库 id」重挂;
    // 跳过的重复文章同样要进这张表,否则它们的评论会全丢
    const existingKeys = new Map(existingArts.map((a) => [artKey(a.notebook_id, a.title, a.content_hash), a.id]))

    const artMap = new Map<number, number>() // 备份中的文章 id -> 本库 id

    const inserts: D1PreparedStatement[] = []
    const insertContents: string[] = []
    const insertOldIds: number[] = []
    let skipped = 0
    for (const a of data.articles) {
      const nbId = nbMap.get(a?.notebook_id)
      if (!nbId || typeof a?.title !== 'string' || !a.title) { skipped++; continue }
      const content = typeof a.content === 'string' ? a.content : ''
      const hash = await contentHash(content)
      const key = artKey(nbId, a.title, hash)
      if (existingKeys.has(key)) {
        const dup = existingKeys.get(key)
        if (dup !== undefined && dup > 0 && typeof a.id === 'number') artMap.set(a.id, dup)
        skipped++
        continue
      }
      existingKeys.set(key, -1) // 占位:同一份文件里的重复项也要跳过,真实 id 插入后回填
      // P12.11:公开状态与浏览数一并恢复,否则恢复完整个博客是空的。
      // is_public 与 is_private 互斥由这里保证(与 PUT /api/articles/:id 同一条规则)。
      // P16.5:目标笔记本在私密分支里就强制上锁——备份里说不私有也照锁,安全方向宁可多锁。
      const priv = (a.is_private || shouldBePrivateIn(privRows, nbId)) ? 1 : 0
      inserts.push(c.env.DB.prepare(
        `INSERT INTO articles (notebook_id, user_id, title, content, content_hash, is_vectorized, tags, pinned,
                               is_public, is_private, is_page, published_at, views)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(nbId, user.id, a.title, content, hash,
        typeof a.tags === 'string' && a.tags ? a.tags : null, a.pinned ? 1 : 0,
        !priv && a.is_public ? 1 : 0, priv, a.is_page ? 1 : 0,
        typeof a.published_at === 'string' ? a.published_at : null,
        Number.isFinite(a.views) ? Math.max(0, Math.trunc(a.views)) : 0))
      insertContents.push(content)
      insertOldIds.push(typeof a.id === 'number' ? a.id : -1)
    }
    if (inserts.length > 0) {
      const created = await c.env.DB.batch(inserts)
      // 一条语句刷全部笔记本(逐本 recountNotebook 在导入时是 N 条语句)。
      // deleted_at IS NULL 这个条件是 P16.6 补的:少了它会把回收站里的文章也算进去,
      // 与其他所有重算点的口径不一致——「同一个派生值有两种算法」迟早对不上
      await c.env.DB.prepare(
        `UPDATE notebooks SET article_count =
           (SELECT COUNT(*) FROM articles WHERE notebook_id = notebooks.id AND deleted_at IS NULL),
         updated_at = datetime('now') WHERE user_id = ?`
      ).bind(user.id).run()
      // 登记导入文章的附件引用索引(R2 对象按原 key 恢复后,可访问性判定随之恢复)
      for (let i = 0; i < created.length; i++) {
        const newId = created[i]?.meta?.last_row_id
        if (newId) {
          if (insertOldIds[i] > 0) artMap.set(insertOldIds[i], newId as number)
          await syncArticleFiles(c.env, user.id, newId as number, insertContents[i])
        }
      }
    }

    // 3. 评论(P12.11):按 artMap 重挂到本库文章;parent_id/root_id 要跟着重映射,
    // 否则楼中楼会挂到别人的评论上。分两步:先按备份里的 id 升序插入拿到新 id,再回填父子关系。
    const comments = Array.isArray(data.comments) ? data.comments : []
    let commentsImported = 0
    if (comments.length > 0 && artMap.size > 0) {
      const { results: existingCms } = await c.env.DB.prepare(
        `SELECT cm.article_id, cm.author_name, cm.content, cm.created_at
           FROM comments cm JOIN articles a ON a.id = cm.article_id WHERE a.user_id = ?`
      ).bind(user.id).all<{ article_id: number; author_name: string; content: string; created_at: string }>()
      const cmKey = (aid: number, name: string, content: string, at: string) => [aid, name, content, at].join('')
      const seenCms = new Set((existingCms ?? []).map((x) => cmKey(x.article_id, x.author_name, x.content, x.created_at)))

      const cmInserts: D1PreparedStatement[] = []
      const cmOld: any[] = []
      for (const cm of [...comments].sort((x: any, y: any) => (x?.id || 0) - (y?.id || 0))) {
        const aid = artMap.get(cm?.article_id)
        if (!aid || typeof cm?.author_name !== 'string' || typeof cm?.content !== 'string') continue
        const at = typeof cm.created_at === 'string' ? cm.created_at : ''
        const key = cmKey(aid, cm.author_name, cm.content, at)
        if (seenCms.has(key)) continue
        seenCms.add(key)
        cmInserts.push(c.env.DB.prepare(
          `INSERT INTO comments (article_id, author_name, author_email, content, status, is_admin, ip, user_agent, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
        ).bind(aid, cm.author_name, cm.author_email || null, cm.content,
          cm.status === 'approved' ? 'approved' : 'pending', cm.is_admin ? 1 : 0,
          cm.ip || null, cm.user_agent || null, at || null))
        cmOld.push(cm)
      }
      if (cmInserts.length > 0) {
        const createdCms = await c.env.DB.batch(cmInserts)
        const cmMap = new Map<number, number>()
        createdCms.forEach((r: any, i: number) => {
          const nid = r?.meta?.last_row_id
          if (nid && typeof cmOld[i]?.id === 'number') cmMap.set(cmOld[i].id, nid as number)
        })
        const relinks: D1PreparedStatement[] = []
        createdCms.forEach((r: any, i: number) => {
          const nid = r?.meta?.last_row_id
          const parent = cmMap.get(cmOld[i]?.parent_id)
          const root = cmMap.get(cmOld[i]?.root_id)
          // 父楼没跟着进来(被删过)就留空,降级成顶层楼,不要挂个悬空 id
          if (nid && (parent || root)) {
            relinks.push(c.env.DB.prepare('UPDATE comments SET parent_id = ?, root_id = ? WHERE id = ?')
              .bind(parent ?? null, root ?? null, nid as number))
          }
        })
        if (relinks.length > 0) await c.env.DB.batch(relinks)
        commentsImported = cmInserts.length
      }
    }

    // 4. 设置(P12.11):只恢复博客展示层的键,且**不覆盖已有值**——
    // 往一个已经配好的站里导备份,不该把人家现在的主题冲掉。
    let settingsRestored = 0
    const incomingSettings = data.settings && typeof data.settings === 'object' ? data.settings : {}
    const settingStmts: D1PreparedStatement[] = []
    for (const [k, v] of Object.entries(incomingSettings)) {
      if (typeof v !== 'string' || !isRestorableSetting(k)) continue
      settingStmts.push(c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').bind(k, v))
    }
    if (settingStmts.length > 0) {
      const before = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>()
      await c.env.DB.batch(settingStmts)
      const after = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first<{ n: number }>()
      settingsRestored = Math.max(0, (after?.n || 0) - (before?.n || 0))
    }

    logSystem(c.env, 'info', 'import', '备份导入完成', {
      notebooks_created: toCreate.length, articles_imported: inserts.length, articles_skipped: skipped,
      comments_imported: commentsImported, settings_restored: settingsRestored,
    })
    return ok({
      notebooks_created: toCreate.length,
      articles_imported: inserts.length,
      articles_skipped: skipped,
      comments_imported: commentsImported,
      settings_restored: settingsRestored,
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
