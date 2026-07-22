import { describe, it, expect } from 'vitest'
import { escapeLike, makeSnippet } from '../worker/routes/search'

// ---- escapeLike:LIKE 特殊字符转义,防止 % _ 被当作通配符 ----

describe('escapeLike', () => {
  it('转义 % _ 和反斜杠', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })

  it('普通中英文原样返回', () => {
    expect(escapeLike('向量搜索 test')).toBe('向量搜索 test')
  })
})

// ---- makeSnippet:关键词命中片段摘录 ----

describe('makeSnippet', () => {
  it('命中位置前后摘录并加省略号', () => {
    const content = 'a'.repeat(100) + '目标词' + 'b'.repeat(200)
    const snip = makeSnippet(content, ['目标词'])
    expect(snip).toContain('目标词')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip.length).toBeLessThanOrEqual(162)
  })

  it('命中在开头时不加前省略号', () => {
    const snip = makeSnippet('目标词' + 'x'.repeat(300), ['目标词'])
    expect(snip.startsWith('目标词')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
  })

  it('多个词取最早命中位置;大小写不敏感', () => {
    const content = 'x'.repeat(50) + 'Alpha' + 'y'.repeat(50) + 'beta' + 'z'.repeat(50)
    const snip = makeSnippet(content, ['BETA', 'alpha'])
    expect(snip).toContain('Alpha')
  })

  it('无命中时返回开头 160 字', () => {
    const content = 'c'.repeat(500)
    expect(makeSnippet(content, ['不存在'])).toBe('c'.repeat(160))
  })
})
