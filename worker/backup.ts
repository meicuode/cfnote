import { getSettingValues, logSystem } from './utils'
import {
  BACKUP_KEYS, backupKey, backupPrefix, backupTimeOf, dueAt, isBackupName,
  isDue, keysToPrune, parseInterval, parseKeep,
} from '../src/lib/backupPlan'
import type { Env } from '../src/types'

// 自动备份(P14.2)。此前唯一的备份手段是你手动点「导出」——手不点就没有备份。
// D1 自带的 Time Travel 只在同一个 Cloudflare 账号里有效,账号本身出问题时它一起没,
// 所以要的是一份**能搬走的 JSON**。
//
// 备份只含 D1(笔记本/文章/评论/对话/设置/附件元数据),**不含附件字节**:
// 附件本来就在 R2 里,把 R2 复制到 R2 只是把容量翻倍买同一份风险。
// 含附件的 ZIP 完整备份仍走浏览器端打包(设置面板里那个按钮)。

/** 不进备份、也不下发给前端的设置键:凭据类一律排除,通知渠道整块 JSON 里含 token/webhook */
export const SENSITIVE_PATTERNS = /key|token|secret/i
export const CHANNELS_KEY = 'notify_channels'

export interface BackupUser {
  id: number
  username: string
}

/**
 * 导出用的完整数据快照。手动导出(/api/export)与自动备份共用同一份构建逻辑——
 * 分成两份写法的话,总有一天其中一份会漏掉新表,而漏掉的那份多半就是没人看的那份。
 */
export async function buildExportPayload(
  env: Env, user: BackupUser, withVersions: boolean,
): Promise<Record<string, unknown>> {
  const [notebooks, articles, convs, msgs, settingsRows, fileRows, folderRows, commentRows, versionRows] = await Promise.all([
    // parent_id / is_private 是 P16.8 补的:P16.1 建了树、P16.5 加了私密标志,
    // 但这条 SELECT 一直没跟上,于是**恢复出来的是一层平铺、私密笔记本变回普通笔记本**。
    // 后者尤其阴:老笔记的 is_private 在 articles 里带着,看着没事,可笔记本本身不再私密,
    // 此后新写进这一支的笔记不再自动上锁——正是 P16.5.2 说的「泄露风险是延迟的,而你不会注意到」。
    env.DB.prepare('SELECT id, name, description, color, parent_id, is_private, created_at, updated_at FROM notebooks WHERE user_id = ? AND deleted_at IS NULL ORDER BY id').bind(user.id).all(),
    // P12.11 补上博客那一层:此前只导正文,恢复之后所有文章都变回未公开、浏览数归零
    env.DB.prepare('SELECT id, notebook_id, title, content, tags, pinned, is_public, is_private, COALESCE(is_page, 0) AS is_page, published_at, views, created_at, updated_at FROM articles WHERE user_id = ? AND deleted_at IS NULL ORDER BY id').bind(user.id).all(),
    env.DB.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY id').bind(user.id).all(),
    env.DB.prepare('SELECT m.id, m.conversation_id, m.role, m.content, m.sources, m.created_at FROM messages m JOIN conversations cv ON m.conversation_id = cv.id WHERE cv.user_id = ? ORDER BY m.id').bind(user.id).all(),
    env.DB.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>(),
    env.DB.prepare('SELECT id, key, name, folder_id, size, content_type, category, created_at FROM files WHERE user_id = ? ORDER BY id').bind(user.id).all().catch(() => ({ results: [] })),
    env.DB.prepare('SELECT id, name, parent_id, created_at FROM folders WHERE user_id = ? ORDER BY id').bind(user.id).all().catch(() => ({ results: [] })),
    // 评论含邮箱与 IP:这是本人的完整备份,备份丢数据就不叫备份;而同一个文件里本来就是整个知识库,
    // 比访客 IP 敏感得多。公开接口那条「永不返回 ip/user_agent/author_email」的规矩只管 /api/blog/comments。
    env.DB.prepare(
      `SELECT cm.id, cm.article_id, cm.parent_id, cm.root_id, cm.author_name, cm.author_email,
              cm.content, cm.status, cm.is_admin, cm.ip, cm.user_agent, cm.created_at
         FROM comments cm JOIN articles a ON a.id = cm.article_id
        WHERE a.user_id = ? ORDER BY cm.id`
    ).bind(user.id).all().catch(() => ({ results: [] })),
    withVersions
      ? env.DB.prepare('SELECT id, article_id, title, content, tags, created_at FROM article_versions WHERE user_id = ? ORDER BY id').bind(user.id).all().catch(() => ({ results: [] }))
      : Promise.resolve({ results: [] }),
  ])

  const settings: Record<string, string> = {}
  for (const r of settingsRows.results ?? []) {
    if (SENSITIVE_PATTERNS.test(r.key) || r.key === CHANNELS_KEY) continue
    settings[r.key] = r.value
  }

  return {
    app: 'cfnote',
    export_version: 2,
    exported_at: new Date().toISOString(),
    username: user.username,
    notebooks: notebooks.results ?? [],
    articles: articles.results ?? [],
    conversations: convs.results ?? [],
    messages: (msgs.results ?? []).map((m: any) => ({ ...m, sources: m.sources ? JSON.parse(m.sources) : null })),
    files: fileRows.results ?? [],
    folders: folderRows.results ?? [],
    comments: commentRows.results ?? [],
    article_versions: versionRows.results ?? [],
    settings,
  }
}

// ---- R2 上的备份文件 ----

export interface BackupFile {
  name: string
  key: string
  size: number
  created_at: string
}

/** 某个用户的全部备份,新的在前 */
export async function listBackups(env: Env, userId: number): Promise<BackupFile[]> {
  if (!env.BUCKET) return []
  const prefix = backupPrefix(userId)
  const out: BackupFile[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ prefix, cursor, limit: 200 })
    for (const o of page.objects) {
      const name = o.key.slice(prefix.length)
      if (!isBackupName(name)) continue
      out.push({ name, key: o.key, size: o.size, created_at: backupTimeOf(name) || o.uploaded.toISOString() })
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out.sort((a, b) => (a.name < b.name ? 1 : -1))
}

/** 删掉超出保留份数的旧备份,返回删了几份 */
export async function pruneBackups(env: Env, userId: number, keep: number): Promise<number> {
  if (!env.BUCKET) return 0
  const drop = keysToPrune((await listBackups(env, userId)).map((b) => b.key), keep)
  for (let i = 0; i < drop.length; i += 100) {
    await env.BUCKET.delete(drop.slice(i, i + 100))
  }
  return drop.length
}

async function putSettings(env: Env, kv: Record<string, string>): Promise<void> {
  const stmts = Object.entries(kv).map(([k, v]) =>
    env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind(k, v))
  if (stmts.length > 0) await env.DB.batch(stmts)
}

export interface BackupRun {
  files: number
  bytes: number
  pruned: number
}

/**
 * 真正写一份备份。cron 与「立即备份一次」共用。
 * 逐用户一份(实际就一个用户,但这样不必假设 users 表里只有一行)。
 */
export async function backupOnce(env: Env, nowMs: number): Promise<BackupRun> {
  if (!env.BUCKET) throw new Error('未配置附件存储(R2),无法备份到云端')
  const { results: users } = await env.DB.prepare('SELECT id, username FROM users ORDER BY id')
    .all<BackupUser>()
  const keep = parseKeep((await getSettingValues(env, [BACKUP_KEYS.keep])).get(BACKUP_KEYS.keep))

  let files = 0
  let bytes = 0
  let pruned = 0
  for (const u of users || []) {
    // 历史版本不进自动备份:每篇可能几十版,体积翻好几倍,而 Worker 的内存与 CPU 都有上限。
    // 要带版本请手动导出(设置里那个勾)。
    const payload = await buildExportPayload(env, u, false)
    // 先编码再 put:.length 是 UTF-16 码元数,中文正文会少算一半以上,
    // 而这个数字要显示成「上次备份 1.2 MB」,算错了就是在骗自己
    const body = new TextEncoder().encode(JSON.stringify(payload))
    await env.BUCKET.put(backupKey(u.id, nowMs), body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { app: 'cfnote', kind: 'backup', user: String(u.id) },
    })
    files++
    bytes += body.byteLength
    pruned += await pruneBackups(env, u.id, keep)
  }
  return { files, bytes, pruned }
}

/** 记账:推进调度锚点 + 记下上次备份的时间与大小,并清掉上一次的错误 */
async function recordRun(env: Env, nowMs: number, bytes: number): Promise<void> {
  await putSettings(env, {
    [BACKUP_KEYS.anchorAt]: new Date(nowMs).toISOString(),
    [BACKUP_KEYS.lastAt]: new Date(nowMs).toISOString(),
    [BACKUP_KEYS.lastSize]: String(bytes),
    [BACKUP_KEYS.lastError]: '',
  })
}

/** 手动「立即备份一次」:不看到期时间,备完照样把下一次顺延(刚备过就别 5 分钟后再来一遍) */
export async function runBackup(env: Env, nowMs: number): Promise<BackupRun> {
  const r = await backupOnce(env, nowMs)
  await recordRun(env, nowMs, r.bytes)
  return r
}

export interface AutoBackupResult extends Partial<BackupRun> {
  ran: boolean
  reason: 'ok' | 'no-bucket' | 'off' | 'not-due' | 'no-user' | 'error' | 'unavailable'
}

/**
 * cron 入口。**没有新开 cron 触发器**,而是搭在既有的那条「每 5 分钟」上,
 * 用 settings 里的调度锚点当闸门。三个理由:
 *  - 免费版每个 Worker 能挂几条 cron 我没法在这个网络环境下核实,加一条如果撞上限
 *    会让**整个部署失败**,而部署失败是所有人都看得见的、最坏的失败方式;
 *  - 于是「多久备一次」变成设置项而不是写死的 cron 表达式:改频率不用改 wrangler.toml、
 *    不用重新部署,forker 那条「不必改 wrangler.toml」的约定也一并保住;
 *  - 代价是每 5 分钟多读一行 settings —— 一天 288 次行读,相对 5M/天可以忽略,
 *    而那条 cron 本来就要为提醒推送查一次 D1。
 */
export async function runAutoBackup(env: Env, nowMs = Date.now()): Promise<AutoBackupResult> {
  if (!env.BUCKET) return { ran: false, reason: 'no-bucket' }
  try {
    const s = await getSettingValues(env, [BACKUP_KEYS.interval, BACKUP_KEYS.anchorAt])
    const interval = parseInterval(s.get(BACKUP_KEYS.interval))
    if (interval === 'off') return { ran: false, reason: 'off' }
    if (!isDue(nowMs, dueAt(s.get(BACKUP_KEYS.anchorAt), interval))) return { ran: false, reason: 'not-due' }
    // 先把锚点推到现在再干活,两件事一起解决:两个 isolate 同时被唤醒时后进来的直接判
    // 「未到期」;而失败也**不回滚**它——宁可这一轮不备,也不要卡在失败上每 5 分钟
    // 重试一次、把 R2 操作和系统日志刷爆。错误落 last_error,设置面板红字看得见。
    await putSettings(env, { [BACKUP_KEYS.anchorAt]: new Date(nowMs).toISOString() })
  } catch {
    // 连 settings 都读不到(库还没初始化):静默,下一个窗口再来
    return { ran: false, reason: 'unavailable' }
  }

  try {
    const r = await backupOnce(env, nowMs)
    // 一个用户都没有(刚部署还没注册):不记账,免得设置里显示「上次备份 0 B」
    if (r.files === 0) return { ran: false, reason: 'no-user' }
    await recordRun(env, nowMs, r.bytes)
    return { ran: true, reason: 'ok', ...r }
  } catch (e: any) {
    const msg = e?.message || String(e)
    await putSettings(env, { [BACKUP_KEYS.lastError]: msg }).catch(() => { /* 记不下就算了 */ })
    logSystem(env, 'error', 'backup', '自动备份失败', { error: msg })
    return { ran: false, reason: 'error' }
  }
}
