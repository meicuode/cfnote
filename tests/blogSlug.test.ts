import { describe, it, expect } from 'vitest'
import { slugify, postPath, MAX_SLUG_LEN } from '../src/lib/blogSlug'

describe('slugify', () => {
  it('英文标题:小写 + 空格转连字符', () => {
    expect(slugify('Deploy to Cloudflare Workers')).toBe('deploy-to-cloudflare-workers')
  })

  it('中文原样保留(可读性正是做 slug 的理由)', () => {
    expect(slugify('部署 Cloudflare Workers')).toBe('部署-cloudflare-workers')
    expect(slugify('我的第一篇笔记')).toBe('我的第一篇笔记')
  })

  it('标点一律丢弃,不留下连字符残渣', () => {
    expect(slugify('Hello, World! (2026)')).toBe('hello-world-2026')
    expect(slugify('《如何部署》——上篇')).toBe('如何部署上篇')
    expect(slugify('a...b')).toBe('ab')
  })

  it('连续空白/连字符折成一个,首尾不留', () => {
    expect(slugify('  a   b  ')).toBe('a-b')
    expect(slugify('--a--b--')).toBe('a-b')
  })

  it('下划线保留(它在 URL 里是安全字符,且常见于代码类标题)', () => {
    expect(slugify('use_effect 用法')).toBe('use_effect-用法')
  })

  it('算不出东西时返回空串,而不是占位词', () => {
    // 空串意味着「退回 /blog/12」,而不是造一个谁也看不懂的 /blog/12/section
    expect(slugify('')).toBe('')
    expect(slugify(null)).toBe('')
    expect(slugify(undefined)).toBe('')
    expect(slugify('!!!')).toBe('')
    expect(slugify('   ')).toBe('')
  })

  it('超长截断,且截断后末尾不留连字符', () => {
    const long = 'a'.repeat(MAX_SLUG_LEN + 20)
    expect(slugify(long)).toHaveLength(MAX_SLUG_LEN)
    // 第 60 个字符正好是连字符时要清掉
    expect(slugify('x'.repeat(MAX_SLUG_LEN - 1) + ' yyy')).toBe('x'.repeat(MAX_SLUG_LEN - 1))
  })

  it('maxLen 可关掉(传 0)', () => {
    const long = 'b'.repeat(200)
    expect(slugify(long, 0)).toHaveLength(200)
  })
})

describe('postPath', () => {
  it('带 slug 的规范路径,且 percent-encode 过', () => {
    expect(postPath(12, 'Deploy to Cloudflare')).toBe('/blog/12/deploy-to-cloudflare')
    // 硬编码一次真实字节:sitemap/RSS 的 XML 要求 URL 已转义,漏了会产出非法文档
    expect(postPath(1, '部署')).toBe('/blog/1/%E9%83%A8%E7%BD%B2')
  })

  it('encode 之后不含 XML/HTML 特殊字符(& < > " 一律进不来)', () => {
    const p = postPath(3, 'A & B <tag> "q"')
    expect(p).toBe('/blog/3/a-b-tag-q')
    expect(/[&<>"']/.test(p)).toBe(false)
  })

  it('encode 之后仍能还原回可读 slug', () => {
    const p = postPath(7, '部署 Cloudflare Workers')
    expect(decodeURIComponent(p)).toBe('/blog/7/部署-cloudflare-workers')
  })

  it('标题算不出 slug → 退回裸 id 路径', () => {
    expect(postPath(12, '')).toBe('/blog/12')
    expect(postPath(12, null)).toBe('/blog/12')
    expect(postPath(12, '???')).toBe('/blog/12')
    expect(postPath(12)).toBe('/blog/12')
  })

  it('id 可以是字符串(worker 侧的路由参数就是字符串)', () => {
    expect(postPath('9', 'hello')).toBe('/blog/9/hello')
  })

  it('产出的路径永远能被客户端那条 ^/blog/(\\d+) 解析回 id', () => {
    for (const [id, title] of [[12, '部署指南'], [3, 'a b c'], [400, ''], [5, '!!!']] as [number, string][]) {
      const m = /^\/blog\/(\d+)/.exec(postPath(id, title))
      expect(m && Number(m[1])).toBe(id)
    }
  })
})
