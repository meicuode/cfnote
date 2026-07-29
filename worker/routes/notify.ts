import { Hono } from 'hono'
import { ok, err, logSystem } from '../utils'
import { buildRequest, mergeMaskedChannels, type NotifyChannel, type NotifyMessage } from '../../src/lib/notifyChannels'
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
  const settingRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'notify_channels'").first<{ value: string }>()
  let channels: NotifyChannel[] = []
  try { channels = settingRow?.value ? JSON.parse(settingRow.value) : [] } catch { channels = [] }
  const enabled = channels.filter((ch) => ch?.enabled)
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

// 有新评论待审核时推送管理员(复用已配置的通知渠道;无渠道则静默,失败不影响主流程)。
export async function notifyPendingComment(
  env: Env,
  info: { articleId: number; articleTitle: string; author: string; content: string }
): Promise<void> {
  try {
    const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'notify_channels'").first<{ value: string }>()
    let channels: NotifyChannel[] = []
    try { channels = row?.value ? JSON.parse(row.value) : [] } catch { channels = [] }
    const enabled = channels.filter((ch) => ch?.enabled)
    if (enabled.length === 0) return
    const siteRow = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first<{ value: string }>()
    const site = (siteRow?.value || '').replace(/\/+$/, '')
    const snippet = info.content.length > 80 ? info.content.slice(0, 80) + '…' : info.content
    const msg: NotifyMessage = {
      title: `💬 新评论待审核:${info.articleTitle || '(无标题)'}`,
      body: `${info.author}:${snippet}`,
      url: site ? `${site}/blog/${info.articleId}` : undefined,
    }
    for (const ch of enabled) {
      const r = await sendToChannel(ch, msg)
      if (!r.ok) logSystem(env, 'warn', 'notify', `渠道 ${ch.type} 评论通知失败`, r.error)
    }
  } catch { /* 通知失败不影响评论提交 */ }
}
