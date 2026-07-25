import { describe, it, expect } from 'vitest'
import { buildRequest, messageText, CHANNEL_META, CHANNEL_TYPES, type NotifyChannel } from '../src/lib/notifyChannels'

const msg = { title: '⏰ 提醒:周报', body: '笔记本:工作', url: 'https://x.dev/?article=7' }
const ch = (type: any, config: Record<string, string>): NotifyChannel => ({ id: 'a', type, enabled: true, config })

describe('messageText', () => {
  it('拼接标题/正文/链接,跳过空段', () => {
    expect(messageText({ title: 'T' })).toBe('T')
    expect(messageText(msg)).toBe('⏰ 提醒:周报\n笔记本:工作\nhttps://x.dev/?article=7')
  })
})

describe('buildRequest', () => {
  it('telegram:sendMessage 端点 + chat_id/text', () => {
    const r = buildRequest(ch('telegram', { token: 'T:oken', chat_id: '99' }), msg)!
    expect(r.url).toBe('https://api.telegram.org/botT:oken/sendMessage')
    expect(r.body).toMatchObject({ chat_id: '99' })
    expect(r.body.text).toContain('周报')
  })

  it('企业微信:msgtype text', () => {
    const r = buildRequest(ch('wecom', { webhook: 'https://qyapi/x' }), msg)!
    expect(r.url).toBe('https://qyapi/x')
    expect(r.body).toMatchObject({ msgtype: 'text' })
    expect(r.body.text.content).toContain('周报')
  })

  it('飞书:msg_type text', () => {
    const r = buildRequest(ch('feishu', { webhook: 'https://feishu/x' }), msg)!
    expect(r.body).toMatchObject({ msg_type: 'text' })
    expect(r.body.content.text).toContain('周报')
  })

  it('钉钉:msgtype text', () => {
    const r = buildRequest(ch('dingtalk', { webhook: 'https://ding/x' }), msg)!
    expect(r.body).toMatchObject({ msgtype: 'text' })
  })

  it('Server酱:sctapi 端点 + title/desp', () => {
    const r = buildRequest(ch('serverchan', { sendkey: 'SCTKEY' }), msg)!
    expect(r.url).toBe('https://sctapi.ftqq.com/SCTKEY.send')
    expect(r.body.title).toBe('⏰ 提醒:周报')
    expect(r.body.desp).toContain('工作')
  })

  it('自定义 webhook:原样 {title, body, url}', () => {
    const r = buildRequest(ch('webhook', { url: 'https://hook/x' }), msg)!
    expect(r).toEqual({ url: 'https://hook/x', body: { title: msg.title, body: msg.body, url: msg.url } })
  })

  it('配置缺字段返回 null', () => {
    expect(buildRequest(ch('telegram', { token: 'x' }), msg)).toBeNull()
    expect(buildRequest(ch('wecom', {}), msg)).toBeNull()
    expect(buildRequest(ch('serverchan', {}), msg)).toBeNull()
  })
})

describe('CHANNEL_META', () => {
  it('每个类型都有展示名与至少一个字段', () => {
    for (const t of CHANNEL_TYPES) {
      expect(CHANNEL_META[t].label).toBeTruthy()
      expect(CHANNEL_META[t].fields.length).toBeGreaterThan(0)
    }
  })
})
