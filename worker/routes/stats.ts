import { Hono } from 'hono'
import { ok, err, getSettingValue, queryAeSql, AE_DATASET } from '../utils'
import { archiveCompletedMonths } from '../archive'
import type { AppEnv } from '../types'

export const stats = new Hono<AppEnv>()

// 统计口径:
// - "今日/7天/趋势" 按本地自然日统计,时区由 STATS_TZ_OFFSET 指定(小时,默认 +8)
// - 累计 = AE(仅归档边界之后)+ usage_archive 归档值,边界由 /api/stats/archive 推进
// - Workers AI neurons 沿用 UTC 自然日,与 Cloudflare 官方额度重置时间一致

// GET /api/stats - Aggregated usage statistics
stats.get('/', async (c) => {
  const env = c.env
  try {
    // 1. D1 counts
    const [notebookRow, articleRow, vectorizedRow] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) as c FROM notebooks WHERE deleted_at IS NULL').first<{ c: number }>(),
      env.DB.prepare('SELECT COUNT(*) as c FROM articles WHERE deleted_at IS NULL').first<{ c: number }>(),
      env.DB.prepare('SELECT COUNT(*) as c FROM articles WHERE is_vectorized = 1').first<{ c: number }>(),
    ])

    const notebooks = notebookRow?.c ?? 0
    const articles = articleRow?.c ?? 0
    const articles_vectorized = vectorizedRow?.c ?? 0

    // 2. Vectorize info
    let vectors_count = 0
    try {
      const info = await env.VECTORIZE.describe()
      const d = info as any
      vectors_count = d.vectorsCount ?? d.vectorCount ?? 0
    } catch { /* vectorize may not be available locally */ }

    const vectors_limit = 4882
    const vector_usage_percent = vectors_limit > 0 ? Math.round((vectors_count / vectors_limit) * 10000) / 100 : 0

    // 3. Usage data from Analytics Engine + D1 archive
    const cfToken = env.CF_API_TOKEN
    const cfAccount = env.CF_ACCOUNT_ID

    const tzOffsetMs = (Number(env.STATS_TZ_OFFSET ?? '8') || 0) * 3600_000
    const localDate = (utcMs: number) => new Date(utcMs + tzOffsetMs).toISOString().slice(0, 10)
    const today = localDate(Date.now())

    const usage = {
      search_today: 0, search_7d: 0, search_total: 0,
      ai_qa_today: 0, ai_qa_7d: 0, ai_qa_total: 0,
      ai_chat_today: 0, ai_chat_7d: 0, ai_chat_total: 0,
      web_search_today: 0, web_search_7d: 0, web_search_total: 0,
      vectorize_total: 0, import_total: 0,
      model_usage: [] as { model: string; today: number; week: number }[],
    }

    // Initialize 7-day trend (local calendar days, oldest first)
    const trendMap: Record<string, { search: number; ai_qa: number; ai_chat: number; web_search: number }> = {}
    for (let i = 6; i >= 0; i--) {
      trendMap[localDate(Date.now() - i * 86400000)] = { search: 0, ai_qa: 0, ai_chat: 0, web_search: 0 }
    }

    if (cfToken && cfAccount) {
      try {
        const boundary = await getSettingValue(env, 'usage_archive_boundary', '')
        const totalsWhere = /^\d{4}-\d{2}-\d{2}$/.test(boundary)
          ? `WHERE timestamp >= toDateTime('${boundary} 00:00:00')`
          : ''

        const [totalRows, hourRows] = await Promise.all([
          // 累计:只统计归档边界之后,避免与 usage_archive 重复计算
          queryAeSql<{ action: string; total: number }>(cfToken, cfAccount, `
            SELECT blob1 AS action, SUM(double1 * _sample_interval) AS total
            FROM ${AE_DATASET} ${totalsWhere}
            GROUP BY blob1
          `),
          // 近8天按小时分桶,在 JS 里按本地时区聚合成自然日
          queryAeSql<{ hour: string; action: string; model: string; c: number }>(cfToken, cfAccount, `
            SELECT toStartOfInterval(timestamp, INTERVAL '1' HOUR) AS hour,
              blob1 AS action, blob2 AS model, SUM(double1 * _sample_interval) AS c
            FROM ${AE_DATASET}
            WHERE timestamp > NOW() - INTERVAL '8' DAY
            GROUP BY hour, blob1, blob2
          `),
        ])

        for (const r of totalRows) {
          const total = Number(r.total) || 0
          if (r.action === 'search') usage.search_total = total
          if (r.action === 'ai_qa') usage.ai_qa_total = total
          if (r.action === 'ai_chat') usage.ai_chat_total = total
          if (r.action === 'web_search') usage.web_search_total = total
          if (r.action === 'vectorize') usage.vectorize_total = total
          if (r.action === 'import') usage.import_total = total
        }

        const modelStats: Record<string, { today: number; week: number }> = {}
        for (const r of hourRows) {
          const iso = r.hour.includes('T') ? r.hour : r.hour.replace(' ', 'T') + 'Z'
          const utcMs = Date.parse(iso)
          if (Number.isNaN(utcMs)) continue
          const d = localDate(utcMs)
          const trend = trendMap[d]
          if (!trend) continue // 第8天的残留小时,不在7天窗口内
          const n = Number(r.c) || 0
          const isToday = d === today

          if (r.action === 'search') { usage.search_7d += n; if (isToday) usage.search_today += n }
          if (r.action === 'ai_qa') { usage.ai_qa_7d += n; if (isToday) usage.ai_qa_today += n }
          if (r.action === 'ai_chat') { usage.ai_chat_7d += n; if (isToday) usage.ai_chat_today += n }
          if (r.action === 'web_search') { usage.web_search_7d += n; if (isToday) usage.web_search_today += n }
          if (r.action in trend) trend[r.action as keyof typeof trend] += n

          if (r.model) {
            const m = modelStats[r.model] ?? (modelStats[r.model] = { today: 0, week: 0 })
            m.week += n
            if (isToday) m.today += n
          }
        }

        usage.model_usage = Object.entries(modelStats)
          .map(([model, v]) => ({ model, ...v }))
          .sort((a, b) => b.week - a.week)
      } catch (e) {
        console.error('Failed to fetch AE usage:', e)
      }
    }

    // Add archived totals from D1 (data beyond the AE boundary)
    try {
      const archiveRows = await env.DB.prepare(
        'SELECT action, SUM(count) as total FROM usage_archive GROUP BY action'
      ).all<{ action: string; total: number }>()
      for (const r of archiveRows.results ?? []) {
        if (r.action === 'search') usage.search_total += r.total
        if (r.action === 'ai_qa') usage.ai_qa_total += r.total
        if (r.action === 'ai_chat') usage.ai_chat_total += r.total
        if (r.action === 'web_search') usage.web_search_total += r.total
        if (r.action === 'vectorize') usage.vectorize_total += r.total
        if (r.action === 'import') usage.import_total += r.total
      }
    } catch { /* archive table may not exist yet */ }

    const daily_trend = Object.entries(trendMap).map(([date, v]) => ({ date, ...v }))

    // 4. CF GraphQL API for Workers AI usage (optional)
    let ai_usage = null
    if (cfToken && cfAccount) {
      try {
        ai_usage = await fetchAiUsage(cfToken, cfAccount)
      } catch (e) {
        console.error('Failed to fetch CF AI usage:', e)
      }
    }

    return ok({
      notebooks, articles, articles_vectorized,
      vectors_count, vectors_limit, vector_usage_percent,
      ai_usage, usage, daily_trend,
    })
  } catch (e: any) {
    return err('获取统计失败: ' + e.message, 500)
  }
})

// POST /api/stats/archive - 手动触发归档(逻辑与月度 cron 共用,见 worker/archive.ts)
stats.post('/archive', async (c) => {
  const cfToken = c.env.CF_API_TOKEN
  const cfAccount = c.env.CF_ACCOUNT_ID
  if (!cfToken || !cfAccount) {
    return err('需要配置 CF_API_TOKEN 和 CF_ACCOUNT_ID', 400)
  }

  try {
    const result = await archiveCompletedMonths(c.env, cfToken, cfAccount)
    return ok(result)
  } catch (e: any) {
    return err('归档失败: ' + e.message, 500)
  }
})

// ---- CF GraphQL API for Workers AI neuron usage ----

async function fetchAiUsage(token: string, accountId: string) {
  const now = new Date()
  const todayStart = now.toISOString().slice(0, 10) + 'T00:00:00Z'
  const nowIso = now.toISOString()
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10) + 'T00:00:00Z'

  const query = `{
    viewer {
      accounts(filter: { accountTag: "${accountId}" }) {
        today: aiInferenceAdaptiveGroups(
          limit: 50
          filter: { datetime_gt: "${todayStart}", datetime_lt: "${nowIso}" }
        ) {
          count
          dimensions { modelId }
          sum { totalNeurons totalInputTokens totalOutputTokens }
        }
        daily: aiInferenceAdaptiveGroups(
          limit: 50
          filter: { datetime_gt: "${sevenDaysAgo}", datetime_lt: "${nowIso}" }
          orderBy: [date_ASC]
        ) {
          count
          dimensions { date modelId }
          sum { totalNeurons totalInputTokens totalOutputTokens }
        }
      }
    }
  }`

  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  })

  if (!res.ok) return null

  const json = await res.json() as any
  const accounts = json?.data?.viewer?.accounts
  if (!accounts || accounts.length === 0) return null
  const account = accounts[0]

  const todayGroups = account.today ?? []
  let neurons_today = 0
  const modelMap: Record<string, { count: number; neurons: number; inputTokens: number; outputTokens: number }> = {}

  for (const g of todayGroups) {
    const modelId = g.dimensions?.modelId ?? 'unknown'
    const n = g.sum?.totalNeurons ?? 0
    neurons_today += n
    if (!modelMap[modelId]) modelMap[modelId] = { count: 0, neurons: 0, inputTokens: 0, outputTokens: 0 }
    modelMap[modelId].count += g.count ?? 0
    modelMap[modelId].neurons += n
    modelMap[modelId].inputTokens += g.sum?.totalInputTokens ?? 0
    modelMap[modelId].outputTokens += g.sum?.totalOutputTokens ?? 0
  }

  const models = Object.entries(modelMap).map(([modelId, v]) => ({ modelId, ...v }))

  const dailyGroups = account.daily ?? []
  const dailyMap: Record<string, { neurons: number; count: number }> = {}
  for (const g of dailyGroups) {
    const date = g.dimensions?.date ?? ''
    if (!date) continue
    if (!dailyMap[date]) dailyMap[date] = { neurons: 0, count: 0 }
    dailyMap[date].neurons += g.sum?.totalNeurons ?? 0
    dailyMap[date].count += g.count ?? 0
  }

  const daily = Object.entries(dailyMap)
    .map(([date, v]) => ({ date, ...v }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return { neurons_today, neurons_limit: 10000, models, daily }
}
