import { describe, it, expect } from 'vitest'
import { isDue, formatRemindTime, splitReminders, toReminderDate } from '../src/lib/reminders'

const NOW = Date.UTC(2026, 6, 25, 12, 0, 0) // 2026-07-25 12:00:00 UTC

describe('toReminderDate', () => {
  it('补 Z 处理无时区的空格格式', () => {
    expect(toReminderDate('2026-07-25 12:00:00').getTime()).toBe(Date.UTC(2026, 6, 25, 12, 0, 0))
    expect(toReminderDate('2026-07-25T12:00:00Z').getTime()).toBe(Date.UTC(2026, 6, 25, 12, 0, 0))
  })
})

describe('isDue', () => {
  it('过去时间已到期,未来时间未到期(与时区无关)', () => {
    expect(isDue('2026-07-25T11:59:00Z', NOW)).toBe(true)
    expect(isDue('2026-07-25T12:00:00Z', NOW)).toBe(true) // 等于 now 视为到期
    expect(isDue('2026-07-25T12:01:00Z', NOW)).toBe(false)
  })
  it('坏值不视为到期', () => {
    expect(isDue('not-a-date', NOW)).toBe(false)
  })
})

describe('formatRemindTime', () => {
  it('已到期返回「已到期」', () => {
    expect(formatRemindTime('2026-07-25T10:00:00Z', NOW)).toBe('已到期')
  })
  it('未来远期返回 MM-DD HH:mm 格式', () => {
    // 取正午 UTC,避开跨时区跨日边界;仅断言格式
    expect(formatRemindTime('2026-08-10T12:00:00Z', NOW)).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('splitReminders', () => {
  it('按到期/未到期分组并保持顺序', () => {
    const items = [
      { id: 1, title: 'a', remind_at: '2026-07-25T09:00:00Z' }, // 到期
      { id: 2, title: 'b', remind_at: '2026-07-25T11:00:00Z' }, // 到期
      { id: 3, title: 'c', remind_at: '2026-07-26T09:00:00Z' }, // 未到期
    ]
    const { due, upcoming } = splitReminders(items, NOW)
    expect(due.map((x) => x.id)).toEqual([1, 2])
    expect(upcoming.map((x) => x.id)).toEqual([3])
  })
})
