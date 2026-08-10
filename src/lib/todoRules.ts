// 待办的时间算术(P18)。全是纯函数,因为这里每一个判断错了都**不报错**——
// 只是提醒在错误的时间到达,或者压根不到达,而人要等到错过截止时间才发现。
// 这类 bug 没有堆栈、没有红条,只能靠单测钉住。
//
// 时区:库里一律存 ISO UTC,但「工作日 / 自然日 / 自然周 / 自然月」是**本地历法概念**。
// UTC+8 的人把截止设在本地周一 09:00 = 周一 01:00Z,这时两边还对得上;
// 设在本地周一 06:00 = **周日** 22:00Z,按 UTC 数工作日就会差一整天。
// 所以每条待办存一个 tz_offset(前端取 -new Date().getTimezoneOffset(),UTC+8 是 480),
// 所有历法运算先把时间戳移进「本地墙上时间」再做,算完移回 UTC。

export type TimeUnit = 'minute' | 'hour' | 'day' | 'workday' | 'week' | 'month'

export interface Offset {
  n: number
  unit: TimeUnit
}

export const UNIT_LABEL: Record<TimeUnit, string> = {
  minute: '分钟',
  hour: '小时',
  day: '自然日',
  workday: '工作日',
  week: '自然周',
  month: '自然月',
}

export const TIME_UNITS: TimeUnit[] = ['minute', 'hour', 'day', 'workday', 'week', 'month']

// 扫描周期。提醒的实际精度就是它:cron 每 5 分钟跑一次,所以「提前 1 分钟」与
// 「提前 3 分钟」收到推送的时刻可能完全一样。分钟这个维度是为「提前 30 分钟」
// 这类需求准备的,填个位数没有意义——界面上要如实说明,不要让人以为能精确到分
export const SCAN_INTERVAL_MIN = 5

/** 新建待办时截止时间的默认提前量(天)。空着不填的话绝大多数待办会没有截止时间,
 *  而没有截止时间 = 永远不会提醒,这个模块就白做了 */
export const DEFAULT_DUE_DAYS = 1

// 逾期后连续提醒的上限。到点了没做完,每天推一次,推满就停——
// 不停的话它会一直响到你删掉它,而那时你已经不看这个渠道了(通知疲劳把**其他**待办
// 的提醒一起废掉,这是不设上限最贵的代价)。
export const OVERDUE_MAX_REMINDS = 2

export const PRIORITY_LABEL: Record<number, string> = { 0: '低', 1: '中', 2: '高', 3: '紧急' }
export const PRIORITY_MARK: Record<number, string> = { 0: '·', 1: '!', 2: '!!', 3: '!!!' }

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/**
 * 解析库里的时间戳,一律按 UTC。
 * 兼容两种形态:ISO(`2026-08-10T09:00:00Z`)与 D1 `datetime('now')` 的空格格式
 * (`2026-08-10 09:00:00`,没有时区后缀但语义是 UTC)。与 fmUtils 的 fmtRemaining 同一套规则。
 */
export function parseUtc(s: string | null | undefined): number | null {
  if (!s) return null
  let v = String(s).trim()
  if (!v) return null
  if (!v.includes('T')) v = v.replace(' ', 'T')
  if (!/(Z|[+-]\d\d:?\d\d)$/.test(v)) v += 'Z'
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** 输出秒级 ISO(去掉毫秒),与库里其他时间列的形态一致 */
export function toIso(ts: number): string {
  return new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const toLocal = (utc: number, tz: number) => utc + tz * MIN
const toUtc = (local: number, tz: number) => local - tz * MIN

/**
 * 加减自然月,日期溢出时**夹到月末**而不是滚到下个月。
 * 1 月 31 日 + 1 个月 = 2 月 28/29 日,不是 3 月 3 日——后者会让「每月最后一天」
 * 这种周期越滚越靠后,几个月后就跑到月中去了。
 */
export function addMonths(ts: number, n: number): number {
  const src = new Date(ts)
  const day = src.getUTCDate()
  const d = new Date(ts)
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + n)
  // 目标月的最后一天:下个月第 0 天
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, last))
  return d.getTime()
}

/**
 * 加减工作日,跳过周六周日。n 可为负(往前数)。
 * 只跳周末,不认法定节假日——那需要一份逐年维护的日历,而错了比没有更坏
 * (「提前 3 个工作日」在一份过期的节假日表下会算出一个静悄悄的错时间)。
 */
export function addWorkdays(ts: number, n: number): number {
  const step = n >= 0 ? DAY : -DAY
  let left = Math.abs(Math.floor(n))
  let cur = ts
  while (left > 0) {
    cur += step
    const dow = new Date(cur).getUTCDay()
    if (dow !== 0 && dow !== 6) left--
  }
  return cur
}

/** 在「本地墙上时间」的时间戳上按单位平移;dir=-1 往前(提前量),dir=1 往后(周期) */
export function shiftLocal(ts: number, off: Offset, dir: 1 | -1): number {
  const n = Math.max(0, Math.floor(Number(off?.n) || 0)) * dir
  if (n === 0) return ts
  switch (off.unit) {
    case 'minute': return ts + n * MIN
    case 'hour': return ts + n * HOUR
    case 'day': return ts + n * DAY
    case 'week': return ts + n * 7 * DAY
    case 'workday': return addWorkdays(ts, n)
    case 'month': return addMonths(ts, n)
    default: return ts
  }
}
/**
 * 由截止时间与提前量算出提醒时间(库里两者都是 UTC ISO,tz 是该待办创建时的本地偏移分钟)。
 *
 * 历法单位先移进本地墙上时间再算:UTC+8 的人把截止设在本地周一 06:00,
 * 那在 UTC 上是**周日** 22:00,按 UTC 数工作日会把周日当成要跳过的那一天,差一整天。
 */
export function computeRemindAt(dueIso: string | null | undefined, off: Offset | null, tz: number): string | null {
  const due = parseUtc(dueIso)
  if (due === null) return null
  if (!off || !off.unit) return toIso(due)
  const local = shiftLocal(toLocal(due, tz), off, -1)
  return toIso(toUtc(local, tz))
}

/** 周期任务:在上一次截止时间上按周期往后推一次 */
export function nextDueAt(dueIso: string | null | undefined, every: Offset | null, tz: number): string | null {
  const due = parseUtc(dueIso)
  if (due === null || !every || !every.unit || !(Number(every.n) > 0)) return null
  const local = shiftLocal(toLocal(due, tz), every, 1)
  return toIso(toUtc(local, tz))
}

export type TodoStatus = 'pending' | 'done'

export interface TodoLike {
  status: TodoStatus
  due_at?: string | null
  remind_at?: string | null
  reminded_at?: string | null
  overdue_reminds?: number | null
}

/** 界面上的三个分类。已完成优先判定:做完了就不该再算逾期(P18 的核心语义之一) */
export function todoBucket(t: TodoLike, now: number): 'done' | 'overdue' | 'pending' {
  if (t.status === 'done') return 'done'
  const due = parseUtc(t.due_at)
  if (due !== null && due <= now) return 'overdue'
  return 'pending'
}

export type DueAction =
  | { kind: 'none' }
  | { kind: 'remind'; reason: 'upcoming' }
  | { kind: 'remind'; reason: 'overdue'; nth: number }

/**
 * 这条待办此刻该不该推送。**cron 的全部判断都收在这里**,
 * 让「什么时候提醒」变成一个能穷举的纯函数,而不是散在 SQL 与循环里的几个 if。
 *
 * 三段语义:
 *  1. 已完成 → 永不提醒。提前标记完成的人不该再被自己的待办追着打
 *  2. 未到截止 → 到了 remind_at 且没推过,推一次(提前提醒)
 *  3. 已过截止 → 每天一次,推满 OVERDUE_MAX_REMINDS 次就停
 *
 * 第 3 段刻意**不看 reminded_at 是否为空**:提前提醒推过之后 reminded_at 就有值了,
 * 若沿用「reminded_at IS NULL 才推」那条件,逾期提醒永远不会发生——
 * 这是整个功能里最容易写错、而且错了完全静默的一处。改用 overdue_reminds 独立计数。
 */
export function dueAction(t: TodoLike, now: number): DueAction {
  if (t.status === 'done') return { kind: 'none' }
  const due = parseUtc(t.due_at)
  const lastPush = parseUtc(t.reminded_at)

  if (due !== null && due <= now) {
    const sent = Math.max(0, Math.floor(Number(t.overdue_reminds) || 0))
    if (sent >= OVERDUE_MAX_REMINDS) return { kind: 'none' }
    // 每天最多一次。第一次逾期推送不等 24 小时(否则到点之后要隔一天才响)
    if (sent > 0 && lastPush !== null && now - lastPush < DAY) return { kind: 'none' }
    return { kind: 'remind', reason: 'overdue', nth: sent + 1 }
  }

  const remind = parseUtc(t.remind_at)
  if (remind === null || remind > now) return { kind: 'none' }
  if (lastPush !== null) return { kind: 'none' }
  return { kind: 'remind', reason: 'upcoming' }
}

/**
 * 距离截止还有多久,按**多个维度**同时表述(填完截止时间后给人看的)。
 *
 * 与 fmtDue 的区别:那个是列表里的一行小字,只取最大的那个量级;这里是填表时的
 * 即时反馈,人需要的恰恰是换算——「3 天」和「2 个工作日」是同一段时间的两种说法,
 * 而选提前量时想的是后者。跨周末时两者能差出一整天,不换算就得自己数日历。
 */
export function describeGap(dueIso: string | null | undefined, now: number, tz = 0): string[] {
  const due = parseUtc(dueIso)
  if (due === null) return []
  const diff = due - now
  if (diff <= 0) return [`已过去 ${fmtSpan(-diff)}`]

  const out = [fmtSpan(diff)]
  // 工作日:按本地日历数,跨周末才有意义(diff 超过一天时才给,否则「0 个工作日」是废话)
  if (diff >= DAY) {
    const wd = countWorkdays(toLocalTs(now, tz), toLocalTs(due, tz))
    if (wd > 0) out.push(`${wd} 个工作日`)
  }
  if (diff >= 7 * DAY) out.push(`约 ${Math.round(diff / (7 * DAY))} 周`)
  return out
}

/** 一段时长的人话形态(天/小时/分钟,取最大量级 + 一位余数) */
export function fmtSpan(ms: number): string {
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MIN)
  if (d > 0) return h > 0 ? `${d} 天 ${h} 小时` : `${d} 天`
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`
  return `${Math.max(1, m)} 分钟`
}

const toLocalTs = (utc: number, tz: number) => utc + tz * MIN

/** 两个时刻之间有几个工作日(不含起点当天,含终点当天;入参是本地墙上时间戳) */
export function countWorkdays(fromLocal: number, toLocal: number): number {
  if (toLocal <= fromLocal) return 0
  let n = 0
  // 从起点的次日 00:00 开始逐日数,避免同一天被算成一个工作日
  const cur = new Date(fromLocal)
  cur.setUTCHours(0, 0, 0, 0)
  let t = cur.getTime() + DAY
  // 上限一年,防止有人把截止时间填到 2099 年时这里空转
  const limit = Math.min(toLocal, t + 366 * DAY)
  while (t <= limit) {
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) n++
    t += DAY
  }
  return n
}

/** 剩余时间的人话形态(与 fmUtils.fmtRemaining 同构,但这里要区分「已逾期多久」) */
export function fmtDue(dueIso: string | null | undefined, now: number): string {
  const due = parseUtc(dueIso)
  if (due === null) return '无截止'
  const diff = due - now
  const abs = Math.abs(diff)
  const unit =
    abs >= DAY ? `${Math.floor(abs / DAY)} 天`
    : abs >= HOUR ? `${Math.floor(abs / HOUR)} 小时`
    : `${Math.max(1, Math.floor(abs / MIN))} 分钟`
  return diff >= 0 ? `还有 ${unit}` : `已逾期 ${unit}`
}

/**
 * 把提醒规则翻译成人话(给面板的规则预览用)。
 * 参数要支持部分对象:新建时 id 还没有,还可能只改了提前量没改截止。
 */
export function describeRule(t: {
  due_at?: string | null
  lead_n?: number | null
  lead_unit?: TimeUnit | null
  repeat_n?: number | null
  repeat_unit?: TimeUnit | null
}): string {
  const due = t.due_at
  const lead = t.lead_n && t.lead_unit && t.lead_n > 0 ? { n: t.lead_n, unit: t.lead_unit } : null
  const rep = t.repeat_n && t.repeat_unit && t.repeat_n > 0 ? { n: t.repeat_n, unit: t.repeat_unit } : null

  if (!due && !lead && !rep) return '不设提醒,纯记事。'
  if (!due) return '没有截止时间,提醒不会触发。'

  const parts: string[] = []
  parts.push(`截止:${due.slice(0, 16).replace('T', ' ')}`)
  if (lead) parts.push(`提前 ${lead.n} ${UNIT_LABEL[lead.unit]}提醒`)
  else parts.push('到点才提醒')
  if (rep) parts.push(`完成后 ${rep.n} ${UNIT_LABEL[rep.unit]}生成下一条`)
  return parts.join(' · ')
}


