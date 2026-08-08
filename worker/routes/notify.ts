import { Hono } from 'hono'
import { ok, err, logSystem } from '../utils'
import { buildRequest, mergeMaskedChannels, type NotifyChannel, type NotifyMessage } from '../../src/lib/notifyChannels'
import { postPath } from '../../src/lib/blogSlug'
import { dueAction, fmtDue, toIso, PRIORITY_MARK, OVERDUE_MAX_REMINDS } from '../../src/lib/todoRules'
import type { AppEnv } from '../types'
import type { Env } from '../../src/types'

export const notify = new Hono<AppEnv>()

// HMAC-SHA256 → base64(钉钉/飞书加签共用)
async function hmacSha256B64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
}

// 向单个渠道发送一条消息;钉钉/飞书按需追加时间戳与签名。
export async function sendToChannel(ch: NotifyChannel, msg: NotifyMessage): Promise<{ ok: boolean; error?: string }> {
  const req = buildRequest(ch, msg)
  if (!req) return { ok: false, error: '渠道配置不完整' }
  let url = req.url
  const body = req.body
  try {
    if (ch.type === 'dingtalk' && ch.config.secret) {
      const ts = Date.now().toString()
      const sign = encodeURIComponent(await hmacSha256B64(ch.config.secret, `${ts}\n${ch.config.secret}`))
      url += (url.includes('?') ? '&' : '?') + `timestamp=${ts}&sign=${sign}`
    }
    if (ch.type === 'feishu' && ch.config.secret) {
      const ts = Math.floor(Date.now() / 1000).toString()
      body.timestamp = ts
      body.sign = await hmacSha256B64(`${ts}\n${ch.config.secret}`, '')
    }
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` }
    const j = (await r.json().catch(() => ({}))) as any
    // 各家成功码不一:errcode/code/StatusCode 为 0 或缺省视为成功(Telegram 用 ok:true)
    const code = j.errcode ?? j.code ?? j.StatusCode
    if (code != null && code !== 0) return { ok: false, error: j.errmsg || j.message || `code ${code}` }
    if (j.ok === false) return { ok: false, error: j.description || '发送失败' }
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: e.message }
  }
}

// GET /api/notify/channels - 渠道自检:**只回「有没有启用的渠道」这一个事实**。
//
// 待办面板要在顶部提示「设了提醒也不会响」,而它只需要知道有没有。
// 走这个接口而不是 GET /api/settings,是因为后者会把整份 notify_channels 下发
// (虽然过了掩码),而这里连掩码后的凭据都不必出现——能少发就少发。
notify.get('/channels', async (c) => {
  const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'notify_channels'").first<{ value: string }>()
  let channels: NotifyChannel[] = []
  try { channels = row?.value ? JSON.parse(row.value) : [] } catch { channels = [] }
  const list = Array.isArray(channels) ? channels : []
  // 只带 type 与 enabled:type 是为了将来能在提示里说「你配了飞书但没启用」
  return ok({ channels: list.map((ch) => ({ type: ch?.type, enabled: !!ch?.enabled })) })
})

// POST /api/notify/test - 用面板里填的渠道配置发一条测试消息。
// 面板拿到的凭据字段是掩码(P12.10),原样发出去只会得到一个 401,所以这里与 PUT /api/settings
// 走同一个合并:仍是掩码的字段取库里的真值。
notify.post('/test', async (c) => {
  try {
    const { channel } = await c.req.json<{ channel: NotifyChannel }>()
    if (!channel?.type) return err('缺少渠道配置')
    const row = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'notify_channels'").first<{ value: string }>()
    let stored: NotifyChannel[] = []
    try { stored = row?.value ? JSON.parse(row.value) : [] } catch { stored = [] }
    const [merged] = mergeMaskedChannels([channel], Array.isArray(stored) ? stored : [])
    const res = await sendToChannel(merged, {
      title: '✅ CFNote 测试消息',
      body: '如果你收到这条消息,说明该渠道已配置成功。',
    })
    return res.ok ? ok({ sent: true }) : err('发送失败: ' + (res.error || '未知错误'))
  } catch (e: any) {
    return err('测试失败: ' + e.message, 500)
  }
})

// 扫描到期未推送的提醒,逐条推送到所有启用渠道(由 */5 cron 调用)。
// 发送后置 reminded_at 防重发;失败写系统日志,仍标记以免刷屏。
export async function sendDueReminders(env: Env): Promise<void> {
  const enabled = await enabledChannels(env)
  if (enabled.length === 0) return

  const { results } = await env.DB.prepare(
    `SELECT a.id, a.title, n.name AS notebook
       FROM articles a LEFT JOIN notebooks n ON n.id = a.notebook_id
      WHERE a.remind_at IS NOT NULL AND a.reminded_at IS NULL AND a.deleted_at IS NULL
        AND datetime(a.remind_at) <= datetime('now')
      LIMIT 50`
  ).all<{ id: number; title: string; notebook: string | null }>()
  if (!results || results.length === 0) return

  const siteRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>()
  const site = (siteRow?.value || '').replace(/\/+$/, '')

  for (const art of results) {
    const msg: NotifyMessage = {
      title: `⏰ 提醒:${art.title || '(无标题)'}`,
      body: art.notebook ? `笔记本:${art.notebook}` : '',
      url: site ? `${site}/?article=${art.id}` : undefined,
    }
    for (const ch of enabled) {
      const r = await sendToChannel(ch, msg)
      if (!r.ok) logSystem(env, 'warn', 'notify', `渠道 ${ch.type} 推送失败`, r.error)
    }
    await env.DB.prepare("UPDATE articles SET reminded_at = datetime('now') WHERE id = ?").bind(art.id).run()
  }
}

/** 已启用的渠道(多处共用:提醒、待办、评论通知) */
async function enabledChannels(env: Env): Promise<NotifyChannel[]> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'notify_channels'").first<{ value: string }>()
  let channels: NotifyChannel[] = []
  try { channels = row?.value ? JSON.parse(row.value) : [] } catch { channels = [] }
  return Array.isArray(channels) ? channels.filter((ch) => ch?.enabled) : []
}

/**
 * 扫描到期的待办并推送(P18,由每 5 分钟那条 cron 调用)。
 *
 * 注意别在这段注释里写 cron 表达式:里面的 星号斜杠 会提前闭合块注释,
 * 而后面几十行就变成了裸代码——第一版就是这么炸的,报错还落在几行之外。
 *
 * 「该不该推」的全部判断在 src/lib/todoRules.ts 的 dueAction 里,这里只负责取数、
 * 发送、写回状态。分开的理由是那个判断有三段语义(已完成 / 提前提醒 / 逾期重复)
 * 且每一段错了都**不报错**——只是提醒在错误的时间到达或者压根不到,
 * 而人要等到错过截止时间才发现。纯函数才能把它们穷举掉。
 *
 * SQL 只做粗筛(未完成、未删、有时间),精确判定交给纯函数:把 dueAction 的三段语义
 * 翻译成 SQL 条件会得到一条没人看得懂、也没法单测的 WHERE 子句。
 */
export async function sendDueTodos(env: Env): Promise<void> {
  const enabled = await enabledChannels(env)
  if (enabled.length === 0) return

  const now = Date.now()
  const { results } = await env.DB.prepare(
    `SELECT id, title, summary, priority, status, due_at, remind_at, reminded_at, overdue_reminds
       FROM todos
      WHERE deleted_at IS NULL AND status = 'pending'
        AND (due_at IS NOT NULL OR remind_at IS NOT NULL)
        AND (datetime(COALESCE(remind_at, due_at)) <= datetime('now')
             OR datetime(due_at) <= datetime('now'))
      LIMIT 50`
  ).all<any>()
  if (!results || results.length === 0) return

  const siteRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>()
  const site = (siteRow?.value || '').replace(/\/+$/, '')

  for (const t of results) {
    const action = dueAction(t, now)
    if (action.kind !== 'remind') continue

    const mark = PRIORITY_MARK[Math.min(3, Math.max(0, Number(t.priority) || 0))] || ''
    const head = action.reason === 'overdue'
      ? `🔴 已逾期(第 ${action.nth}/${OVERDUE_MAX_REMINDS} 次提醒)`
      : '⏰ 待办提醒'
    const msg: NotifyMessage = {
      title: `${head}:${mark} ${t.title || '(无标题)'}`.trim(),
      body: [t.summary || '', t.due_at ? `截止:${fmtDue(t.due_at, now)}` : ''].filter(Boolean).join('\n'),
      url: site ? `${site}/?todo=${t.id}` : undefined,
    }

    // 一个渠道失败不该拖累其他渠道,也不该让这一条卡在「永远重推」的状态:
    // 全部失败才不标记(下一轮再试),有一个成功就算送达
    let anyOk = false
    for (const ch of enabled) {
      const r = await sendToChannel(ch, msg)
      if (r.ok) anyOk = true
      else logSystem(env, 'warn', 'notify', `渠道 ${ch.type} 待办推送失败`, r.error)
    }
    if (!anyOk) continue

    if (action.reason === 'overdue') {
      await env.DB.prepare(
        "UPDATE todos SET reminded_at = ?, overdue_reminds = ? WHERE id = ?"
      ).bind(toIso(now), action.nth, t.id).run()
    } else {
      await env.DB.prepare('UPDATE todos SET reminded_at = ? WHERE id = ?').bind(toIso(now), t.id).run()
    }
  }
}

// 有新评论待审核时推送管理员(复用已配置的通知渠道;无渠道则静默,失败不影响主流程)。
export async function notifyPendingComment(
  env: Env,
  info: { articleId: number; articleTitle: string; author: string; content: string }
): Promise<void> {
  try {
    const enabled = await enabledChannels(env)
    if (enabled.length === 0) return
    const siteRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>()
    const site = (siteRow?.value || '').replace(/\/+$/, '')
    const snippet = info.content.length > 80 ? info.content.slice(0, 80) + '…' : info.content
    const msg: NotifyMessage = {
      title: `💬 新评论待审核:${info.articleTitle || '(无标题)'}`,
      body: `${info.author}:${snippet}`,
      url: site ? `${site}${postPath(info.articleId, info.articleTitle)}` : undefined,
    }
    for (const ch of enabled) {
      const r = await sendToChannel(ch, msg)
      if (!r.ok) logSystem(env, 'warn', 'notify', `渠道 ${ch.type} 评论通知失败`, r.error)
    }
  } catch { /* 通知失败不影响评论提交 */ }
}
