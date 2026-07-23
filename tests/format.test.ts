import { describe, it, expect } from 'vitest'
import { formatBytes } from '../src/lib/format'

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
