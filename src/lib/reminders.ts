// 应用内提醒(P10)纯逻辑:到期判定、相对时间标签、按到期/未到期分组。
// remind_at 为 ISO UTC 字符串;now 传入毫秒时间戳,便于测试与避免隐藏时钟依赖。

export interface ReminderItem {
  id: number
  title: string
  notebook?: string | null
  remind_at: string
}

/** D1/ISO 时间(UTC,可能带或不带 Z)→ Date */
export function toReminderDate(d: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(d) ? d : d.replace(' ', 'T') + 'Z')
}

/** 是否已到期(remind_at <= now) */
export function isDue(remindAt: string, now: number): boolean {
  const t = toReminderDate(remindAt).getTime()
  return !isNaN(t) && t <= now
}

/** 相对时间标签:已到期 / 今天 HH:mm / 明天 HH:mm / MM-DD HH:mm */
export function formatRemindTime(remindAt: string, now: number): string {
  const d = toReminderDate(remindAt)
  if (isNaN(d.getTime())) return ''
  if (d.getTime() <= now) return '已到期'
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  const today = new Date(now)
  if (sameDay(d, today)) return `今天 ${hm}`
  const tmr = new Date(now)
  tmr.setDate(today.getDate() + 1)
  if (sameDay(d, tmr)) return `明天 ${hm}`
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

/** 按到期/未到期分组;各组内保持输入顺序(调用方按 remind_at 升序传入) */
export function splitReminders<T extends { remind_at: string }>(
  items: T[],
  now: number,
): { due: T[]; upcoming: T[] } {
  const due: T[] = []
  const upcoming: T[] = []
  for (const it of items) (isDue(it.remind_at, now) ? due : upcoming).push(it)
  return { due, upcoming }
}
