import { describe, it, expect } from 'vitest'
import {
  buildRequest, messageText, CHANNEL_META, CHANNEL_TYPES,
  maskChannels, mergeMaskedChannels, maskSecret, isMaskedValue, isSecretField, SECRET_FIELDS,
  type NotifyChannel,
} from '../src/lib/notifyChannels'

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

describe('凭据掩码(P12.10)', () => {
  it('掩码只留后四位;短值整段遮掉', () => {
    expect(maskSecret('1234567890')).toBe('****7890')
    expect(maskSecret('abc')).toBe('****')
    expect(maskSecret('')).toBe('')
    expect(isMaskedValue('****7890')).toBe(true)
    expect(isMaskedValue('7890')).toBe(false)
  })

  it('Webhook 地址也是凭据(?key= / ?access_token= 就在 URL 里)', () => {
    expect(isSecretField('wecom', 'webhook')).toBe(true)
    expect(isSecretField('dingtalk', 'webhook')).toBe(true)
    expect(isSecretField('webhook', 'url')).toBe(true)
    // chat_id 不是凭据,遮掉反而看不出配给哪个会话
    expect(isSecretField('telegram', 'chat_id')).toBe(false)
  })

  it('SECRET_FIELDS 覆盖每个渠道除 chat_id 外的全部字段', () => {
    for (const t of CHANNEL_TYPES) {
      for (const f of CHANNEL_META[t].fields) {
        if (f.key === 'chat_id') continue
        expect(SECRET_FIELDS[t]).toContain(f.key)
      }
    }
  })

  it('maskChannels 遮凭据、留其余', () => {
    const [tg] = maskChannels([ch('telegram', { token: '123456:ABCDEFG', chat_id: '99' })])
    expect(tg.config.token).toBe('****DEFG')
    expect(tg.config.chat_id).toBe('99')
    expect(tg.enabled).toBe(true)
  })

  it('mergeMaskedChannels 按 id 还原真值,同时保存非凭据的改动', () => {
    const stored: NotifyChannel[] = [ch('telegram', { token: '123456:ABCDEFG', chat_id: '99' })]
    const incoming: NotifyChannel[] = [
      { ...ch('telegram', { token: '****DEFG', chat_id: '77' }), enabled: false },
    ]
    const [m] = mergeMaskedChannels(incoming, stored)
    expect(m.config.token).toBe('123456:ABCDEFG') // 掩码 → 取回旧值
    expect(m.config.chat_id).toBe('77')           // 非凭据 → 用新值
    expect(m.enabled).toBe(false)
  })

  it('真的改了凭据就按新值存', () => {
    const stored: NotifyChannel[] = [ch('telegram', { token: 'old:TOKEN', chat_id: '99' })]
    const [m] = mergeMaskedChannels([ch('telegram', { token: 'new:TOKEN', chat_id: '99' })], stored)
    expect(m.config.token).toBe('new:TOKEN')
  })

  it('找不到旧值的掩码落成空串,而不是把 **** 当凭据发出去', () => {
    const [m] = mergeMaskedChannels([ch('telegram', { token: '****DEFG', chat_id: '1' })], [])
    expect(m.config.token).toBe('')
    expect(buildRequest(m, msg)).toBeNull()
  })

  it('掩码 → 合并是个恒等回路(不改任何字段时配置原样不变)', () => {
    const stored: NotifyChannel[] = [
      ch('wecom', { webhook: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=SECRETKEY' }),
    ]
    const merged = mergeMaskedChannels(maskChannels(stored), stored)
    expect(merged).toEqual(stored)
  })
})
