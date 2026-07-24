import { describe, it, expect } from 'vitest'
import { scanSensitive } from '../src/lib/sensitiveScan'
import { mdExcerpt, mdFirstImage } from '../src/lib/blogExtract'

// 公开前敏感信息扫描:所有类别命中 + 打码 + 行号;以及关键的误报防护
describe('sensitiveScan', () => {
  it('手机号:命中并打码,普通数字/日期不误报', () => {
    const hits = scanSensitive('联系我:13812345678\n下单日期 2026-07-24,订单号 20260724001')
    expect(hits.filter((h) => h.type === 'phone').length).toBe(1)
    expect(hits[0].line).toBe(1)
    expect(hits[0].excerpt).toContain('138****78')
    expect(hits[0].excerpt).not.toContain('13812345678')
  })

  it('身份证号:出生日期段合理才命中', () => {
    const ok = scanSensitive('身份证:110101199003074512')
    expect(ok.some((h) => h.type === 'idcard')).toBe(true)
    // 出生段 9913 月份不合法 → 不算身份证
    const bad = scanSensitive('流水号 110101991300000000')
    expect(bad.some((h) => h.type === 'idcard')).toBe(false)
  })

  it('银行卡号:Luhn 通过才命中,普通长数字不误报', () => {
    const ok = scanSensitive('招行卡号 6225768888888888(Luhn 合法)')
    expect(ok.some((h) => h.type === 'bankcard')).toBe(true)
    const bad = scanSensitive('快递单号 6225768888888887')
    expect(bad.some((h) => h.type === 'bankcard')).toBe(false)
  })

  it('各类密钥:AWS/sk-/GitHub/Google/Slack/JWT/私钥块/通用赋值', () => {
    const text = [
      'aws: AKIAIOSFODNN7EXAMPLE',
      'openai: sk-abcdefghijklmnop123456',
      'github ghp_abcdefghijklmnopqrstuvwxyz012345',
      'google AIzaSyA-1234567890abcdefghijklmnopqrstu',
      'slack xoxb-123456789012-abcdef',
      'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
      '-----BEGIN RSA PRIVATE KEY-----',
      'api_key = a1b2c3d4e5f6g7h8',
    ].join('\n')
    const hits = scanSensitive(text)
    expect(hits.filter((h) => h.type === 'secret').length).toBeGreaterThanOrEqual(6)
    expect(hits.some((h) => h.type === 'privatekey')).toBe(true)
    expect(hits.some((h) => h.label === 'AWS AccessKey')).toBe(true)
    expect(hits.some((h) => h.label === 'JWT 令牌')).toBe(true)
    // 行号正确
    expect(hits.find((h) => h.label === 'AWS AccessKey')!.line).toBe(1)
  })

  it('密码:显式分隔才命中,叙述文字不误报', () => {
    expect(scanSensitive('数据库密码: P@ssw0rd!').some((h) => h.type === 'password')).toBe(true)
    expect(scanSensitive('password=hunter22').some((h) => h.type === 'password')).toBe(true)
    expect(scanSensitive('登录密码是 abcd1234').some((h) => h.type === 'password')).toBe(true)
    expect(scanSensitive('修改密码的入口在设置页').some((h) => h.type === 'password')).toBe(false)
    expect(scanSensitive('忘记密码时点这里重置').some((h) => h.type === 'password')).toBe(false)
  })

  it('邮箱命中;身份证/银行卡不重复报(区间去重)', () => {
    const hits = scanSensitive('me@example.com 证件 110101199003074512')
    expect(hits.some((h) => h.type === 'email')).toBe(true)
    // 18 位身份证只报 idcard,不再作为银行卡重复报
    const types = hits.filter((h) => h.excerpt.includes('110****12')).map((h) => h.type)
    expect(types).toEqual(['idcard'])
  })

  it('附件地址(32 位随机段)与普通链接不误报', () => {
    const hits = scanSensitive('![图](/api/files/u1/1540aad371ed48229ede0a0d0962dbe2/image.png)\n见 https://example.com/docs')
    expect(hits.length).toBe(0)
  })

  it('干净文档零命中;命中数量有上限', () => {
    expect(scanSensitive('# 学习笔记\n\n今天研究了 TipTap 的序列化机制,收获很大。')).toEqual([])
    const flood = Array.from({ length: 500 }, (_, i) => `1381234${String(5000 + i)}`).join('\n')
    expect(scanSensitive(flood).length).toBeLessThanOrEqual(200)
  })
})

// 博客列表的摘要与缩略图提取
describe('blogExtract', () => {
  it('mdExcerpt:剥掉标题/强调/链接/代码块/表格,留纯文本', () => {
    const md = '# 标题\n\n这是**加粗**和`代码`与[链接文字](https://x.com)。\n\n```ts\nconst secret = 1\n```\n\n| a | b |\n| - | - |'
    const out = mdExcerpt(md, 200)
    expect(out).toContain('这是加粗和代码与链接文字')
    expect(out).not.toContain('#')
    expect(out).not.toContain('**')
    expect(out).not.toContain('const secret')
    expect(out).not.toContain('|')
  })

  it('mdExcerpt:超长截断加省略号', () => {
    const out = mdExcerpt('一'.repeat(300), 120)
    expect(out.length).toBe(121)
    expect(out.endsWith('…')).toBe(true)
  })

  it('mdFirstImage:md 图片/内嵌 img 取更早出现的;代码块内不算;无图返回 null', () => {
    expect(mdFirstImage('前文 ![a](/api/files/u1/k/a.png) 后文 <img src="/b.png">')).toBe('/api/files/u1/k/a.png')
    expect(mdFirstImage('<img src="/b.png" width="300"> 然后 ![a](/a.png)')).toBe('/b.png')
    expect(mdFirstImage('```\n![假图](/code.png)\n```\n![真图](/real.png)')).toBe('/real.png')
    expect(mdFirstImage('没有图片的文档')).toBeNull()
  })
})
