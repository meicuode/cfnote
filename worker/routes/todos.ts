import { Hono } from 'hono'
import { ok, err } from '../utils'
import {
  computeRemindAt, nextDueAt, parseUtc, toIso, serializeChannels, TIME_UNITS,
  type Offset, type TimeUnit,
} from '../../src/lib/todoRules'
import type { NotifyChannel } from '../../src/lib/notifyChannels'
import type { AppEnv } from '../types'

export const todos = new Hono<AppEnv>()

const FIELDS = `id, title, summary, notes, priority, status, due_at, remind_at, reminded_at,
                overdue_reminds, lead_n, lead_unit, repeat_n, repeat_unit, tz_offset, channels,
                article_id, completed_at, created_at, updated_at`

/** 当前已启用渠道的 id 列表(用于把「全选」归一成 null) */
async function enabledIds(env: AppEnv['Bindings']): Promise<string[]> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'notify_channels'").first<{ value: string }>()
  let list: NotifyChannel[] = []
  try { list = row?.value ? JSON.parse(row.value) : [] } catch { list = [] }
  return (Array.isArray(list) ? list : []).filter((c) => c?.enabled).map((c) => c.id)
}

/** 前端传来的渠道选择:必须是字符串数组,其余一律当「跟随全部」 */
function readChannels(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  const ids = v.filter((x) => typeof x === 'string' && x)
  return ids.length > 0 ? ids : null
}

/** 前端传来的偏移量:单位必须在白名单里,n 必须是正整数,否则当「没设」 */
function readOffset(n: unknown, unit: unknown): Offset | null {
  const num = Math.floor(Number(n) || 0)
  const u = String(unit || '') as TimeUnit
  if (num <= 0 || !TIME_UNITS.includes(u)) return null
  return { n: num, unit: u }
}

/** 截止时间:接受 ISO 或 D1 空格格式,归一成秒级 ISO;坏值一律当没有 */
function readDue(v: unknown): string | null {
  const t = parseUtc(typeof v === 'string' ? v : null)
  return t === null ? null : toIso(t)
}

/** 时区偏移分钟。范围外的值落 0(按 UTC 算),而不是让历法运算拿到一个荒谬的基准 */
function readTz(v: unknown): number {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 0
}

const clampPriority = (v: unknown) => Math.min(3, Math.max(0, Math.floor(Number(v) || 0)))
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max)

// GET /api/todos?bucket=pending|overdue|done|all
//
// 分桶在 SQL 里做而不是取回来再筛:待办会一直堆积(已完成的也留着),
// 全取回前端过滤等于每次打开面板都把整张表读一遍,而 D1 的行读是计费维度。
todos.get('/', async (c) => {
  const user = c.get('user')
  const bucket = c.req.query('bucket') || 'pending'
  let where = 'user_id = ? AND deleted_at IS NULL'
  const binds: unknown[] = [user.id]

  if (bucket === 'done') {
    where += " AND status = 'done'"
  } else if (bucket === 'overdue') {
    // 已完成的永远不算逾期——做完了就不该再被自己的待办追着打
    where += " AND status = 'pending' AND due_at IS NOT NULL AND datetime(due_at) <= datetime('now')"
  } else if (bucket === 'pending') {
    where += " AND status = 'pending' AND (due_at IS NULL OR datetime(due_at) > datetime('now'))"
  }

  // 排序:先按截止时间(没有截止的排最后),同期按优先级降序。
  // done 桶按完成时间倒序——那一桶人是来「回顾刚做完什么」的,不是来看截止时间的
  const order = bucket === 'done'
    ? 'completed_at DESC, updated_at DESC'
    : 'CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at ASC, priority DESC, id DESC'

  const { results } = await c.env.DB.prepare(
    `SELECT ${FIELDS} FROM todos WHERE ${where} ORDER BY ${order} LIMIT 200`
  ).bind(...binds).all()

  // 三个桶的计数一次给全:面板上的标签要常显数字,分三次请求是把最紧的额度花在计数上
  const counts = await c.env.DB.prepare(
    `SELECT
       SUM(CASE WHEN status = 'pending' AND (due_at IS NULL OR datetime(due_at) > datetime('now')) THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'pending' AND due_at IS NOT NULL AND datetime(due_at) <= datetime('now') THEN 1 ELSE 0 END) AS overdue,
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
     FROM todos WHERE user_id = ? AND deleted_at IS NULL`
  ).bind(user.id).first<{ pending: number; overdue: number; done: number }>()

  return ok({
    todos: results ?? [],
    counts: {
      pending: counts?.pending ?? 0,
      overdue: counts?.overdue ?? 0,
      done: counts?.done ?? 0,
    },
  })
})

// POST /api/todos - 新建
todos.post('/', async (c) => {
  const user = c.get('user')
  try {
    const b = await c.req.json<any>()
    const title = str(b?.title, 200).trim()
    if (!title) return err('标题不能为空')

    const tz = readTz(b?.tz_offset)
    const due = readDue(b?.due_at)
    const lead = readOffset(b?.lead_n, b?.lead_unit)
    const repeat = readOffset(b?.repeat_n, b?.repeat_unit)
    // 提醒时间是**派生值**,永远由截止时间与提前量算出来,不接受前端直接传。
    // 让前端传的话,两处算法迟早对不上,而对不上的表现是提醒在错误的时间到达——
    // 不报错、不留痕,只有等人错过了才发现
    const remind = computeRemindAt(due, lead, tz)
    const chans = serializeChannels(readChannels(b?.channels), await enabledIds(c.env))

    const r = await c.env.DB.prepare(
      `INSERT INTO todos (user_id, title, summary, notes, priority, due_at, remind_at,
                          lead_n, lead_unit, repeat_n, repeat_unit, tz_offset, channels, article_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      user.id, title, str(b?.summary, 500), str(b?.notes, 20000), clampPriority(b?.priority),
      due, remind,
      lead?.n ?? 0, lead?.unit ?? null, repeat?.n ?? 0, repeat?.unit ?? null, tz, chans,
      Number.isInteger(b?.article_id) && b.article_id > 0 ? b.article_id : null,
    ).run()

    const row = await c.env.DB.prepare(`SELECT ${FIELDS} FROM todos WHERE id = ?`)
      .bind(r.meta.last_row_id).first()
    return ok({ todo: row })
  } catch (e: any) {
    return err('创建失败: ' + e.message, 500)
  }
})

// PUT /api/todos/:id - 修改。改到时间相关的字段就重算提醒时间并**重新武装**推送状态
todos.put('/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('无效的 id')
  try {
    const cur = await c.env.DB.prepare(
      'SELECT * FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(id, user.id).first<any>()
    if (!cur) return err('待办不存在', 404)

    const b = await c.req.json<any>()
    const sets: string[] = []
    const binds: unknown[] = []
    const put = (col: string, v: unknown) => { sets.push(`${col} = ?`); binds.push(v) }

    if (typeof b?.title === 'string') {
      const t = str(b.title, 200).trim()
      if (!t) return err('标题不能为空')
      put('title', t)
    }
    if (typeof b?.summary === 'string') put('summary', str(b.summary, 500))
    if (typeof b?.notes === 'string') put('notes', str(b.notes, 20000))
    if (b?.priority !== undefined) put('priority', clampPriority(b.priority))

    // 时间三件套一起处理:任一变化都要重算 remind_at
    const touchesTime = 'due_at' in (b || {}) || 'lead_n' in (b || {}) || 'lead_unit' in (b || {}) || 'tz_offset' in (b || {})
    if (touchesTime) {
      const tz = 'tz_offset' in b ? readTz(b.tz_offset) : (cur.tz_offset ?? 0)
      const due = 'due_at' in b ? readDue(b.due_at) : (cur.due_at ?? null)
      const lead = ('lead_n' in b || 'lead_unit' in b)
        ? readOffset(b.lead_n ?? cur.lead_n, b.lead_unit ?? cur.lead_unit)
        : readOffset(cur.lead_n, cur.lead_unit)
      put('tz_offset', tz)
      put('due_at', due)
      put('lead_n', lead?.n ?? 0)
      put('lead_unit', lead?.unit ?? null)
      put('remind_at', computeRemindAt(due, lead, tz))
      // 改了时间就重新武装:否则把截止时间往后挪之后,因为 reminded_at 还有值,
      // 新的提醒时间到了也不会推——「我明明改了时间」而它一声不响
      put('reminded_at', null)
      put('overdue_reminds', 0)
    }

    if ('repeat_n' in (b || {}) || 'repeat_unit' in (b || {})) {
      const rep = readOffset(b.repeat_n ?? cur.repeat_n, b.repeat_unit ?? cur.repeat_unit)
      put('repeat_n', rep?.n ?? 0)
      put('repeat_unit', rep?.unit ?? null)
    }

    if ('channels' in (b || {})) {
      put('channels', serializeChannels(readChannels(b.channels), await enabledIds(c.env)))
    }

    if (b?.status === 'done' || b?.status === 'pending') {
      put('status', b.status)
      put('completed_at', b.status === 'done' ? toIso(Date.now()) : null)
      // 重新打开一条已完成的待办,推送状态也要跟着复位
      if (b.status === 'pending') { put('reminded_at', null); put('overdue_reminds', 0) }
    }

    if (sets.length === 0) return ok({ todo: cur })
    sets.push("updated_at = datetime('now')")
    binds.push(id, user.id)
    await c.env.DB.prepare(`UPDATE todos SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
      .bind(...binds).run()

    const row = await c.env.DB.prepare(`SELECT ${FIELDS} FROM todos WHERE id = ?`).bind(id).first()
    return ok({ todo: row })
  } catch (e: any) {
    return err('保存失败: ' + e.message, 500)
  }
})

// POST /api/todos/:id/done - 标记完成。周期待办完成时**当场生成下一条**
//
// 单独开一个接口而不是复用 PUT:这是一次点击就该完成的动作,而且周期任务在这里
// 会产生副作用(多出一条新待办),放在通用的 PUT 里会让「改个标题」也要考虑要不要滚周期
todos.post('/:id/done', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('无效的 id')
  try {
    const cur = await c.env.DB.prepare(
      'SELECT * FROM todos WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
    ).bind(id, user.id).first<any>()
    if (!cur) return err('待办不存在', 404)
    if (cur.status === 'done') return ok({ todo: cur, next: null })

    await c.env.DB.prepare(
      "UPDATE todos SET status = 'done', completed_at = ?, updated_at = datetime('now') WHERE id = ?"
    ).bind(toIso(Date.now()), id).run()

    // 周期任务:滚出下一条。从**上一次的截止时间**推,不是从「现在」推——
    // 按现在推的话,晚做一天就把整个周期往后挪一天,「每周一交周报」会慢慢漂移到周三
    let next = null
    const rep = readOffset(cur.repeat_n, cur.repeat_unit)
    if (rep && cur.due_at) {
      const tz = cur.tz_offset ?? 0
      const nextDue = nextDueAt(cur.due_at, rep, tz)
      const lead = readOffset(cur.lead_n, cur.lead_unit)
      // 渠道选择要跟着滚:上一条指定了发飞书,下一条不该悄悄变回发全部
      const r = await c.env.DB.prepare(
        `INSERT INTO todos (user_id, title, summary, notes, priority, due_at, remind_at,
                            lead_n, lead_unit, repeat_n, repeat_unit, tz_offset, channels, article_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        user.id, cur.title, cur.summary || '', cur.notes || '', cur.priority ?? 1,
        nextDue, computeRemindAt(nextDue, lead, tz),
        lead?.n ?? 0, lead?.unit ?? null, rep.n, rep.unit, tz, cur.channels ?? null,
        cur.article_id ?? null,
      ).run()
      next = await c.env.DB.prepare(`SELECT ${FIELDS} FROM todos WHERE id = ?`)
        .bind(r.meta.last_row_id).first()
    }

    const row = await c.env.DB.prepare(`SELECT ${FIELDS} FROM todos WHERE id = ?`).bind(id).first()
    return ok({ todo: row, next })
  } catch (e: any) {
    return err('操作失败: ' + e.message, 500)
  }
})

// DELETE /api/todos/:id - 软删。与笔记本/文章一致:这个库里没有不可逆的破坏性操作
todos.delete('/:id', async (c) => {
  const user = c.get('user')
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return err('无效的 id')
  const r = await c.env.DB.prepare(
    "UPDATE todos SET deleted_at = datetime('now') WHERE id = ? AND user_id = ? AND deleted_at IS NULL"
  ).bind(id, user.id).run()
  if (!r.meta.changes) return err('待办不存在', 404)
  return ok({ deleted: true })
})
