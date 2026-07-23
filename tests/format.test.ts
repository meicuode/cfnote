import { describe, it, expect } from 'vitest'
import { formatBytes, formatDateTime } from '../src/lib/format'

describe('formatBytes', () => {
  it('字节/KB/MB 分档,KB 小于 10 保留一位小数', () => {
    expect(formatBytes(0)).toBe('')
    expect(formatBytes(-5)).toBe('')
    expect(formatBytes(NaN)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(5 * 1024 + 300)).toBe('5.3 KB')
    expect(formatBytes(123 * 1024)).toBe('123 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(9.6 * 1024 * 1024)).toBe('9.6 MB')
  })
})

describe('formatDateTime', () => {
  it('输出本地 YYYY-MM-DD HH:mm,非法输入返回空串', () => {
    // 用本地时间构造,断言与时区无关
    expect(formatDateTime(new Date(2026, 6, 23, 9, 5))).toBe('2026-07-23 09:05')
    expect(formatDateTime(new Date(2026, 11, 1, 23, 59))).toBe('2026-12-01 23:59')
    expect(formatDateTime('not a date')).toBe('')
  })
})
