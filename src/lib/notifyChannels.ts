// 通知渠道抽象(P10.3):Telegram / 企业微信 / 飞书 / 钉钉 / Server酱 / 自定义 webhook 统一为
// 「一个 URL + 一段 JSON body」。此模块为纯逻辑(类型、字段描述、请求构造),
// 便于前端表单与单测复用;实际 fetch 与钉钉/飞书 HMAC 加签在 worker/routes/notify.ts。

export type ChannelType = 'telegram' | 'wecom' | 'feishu' | 'dingtalk' | 'serverchan' | 'webhook'

export interface NotifyChannel {
  id: string
  type: ChannelType
  enabled: boolean
  config: Record<string, string>
}

export interface NotifyMessage {
  title: string
  body?: string
  url?: string
}

export interface ChannelField {
  key: string
  label: string
  placeholder?: string
  optional?: boolean
}

// 各渠道展示名、配置字段、获取指引(前端表单据此渲染)
export const CHANNEL_META: Record<ChannelType, { label: string; fields: ChannelField[]; help: string }> = {
  wecom: {
    label: '企业微信',
    fields: [{ key: 'webhook', label: '群机器人 Webhook 地址', placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' }],
    help: '企业微信群 → 右上角 → 添加群机器人 → 复制 Webhook 地址。无需域名/审核。',
  },
  feishu: {
    label: '飞书',
    fields: [
      { key: 'webhook', label: '自定义机器人 Webhook 地址', placeholder: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
      { key: 'secret', label: '签名密钥(开启「签名校验」时填)', optional: true },
    ],
    help: '飞书群 → 设置 → 群机器人 → 添加「自定义机器人」;若勾选签名校验,把密钥填到这里。',
  },
  dingtalk: {
    label: '钉钉',
    fields: [
      { key: 'webhook', label: '自定义机器人 Webhook 地址', placeholder: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
      { key: 'secret', label: '加签密钥(安全设置选「加签」时填)', optional: true },
    ],
    help: '钉钉群 → 智能群助手 → 添加「自定义机器人」;安全设置建议选「加签」,把密钥填到这里。',
  },
  serverchan: {
    label: '个人微信(Server酱)',
    fields: [{ key: 'sendkey', label: 'SENDKEY', placeholder: 'SCT...' }],
    help: 'sct.ftqq.com 用微信扫码登录、关注公众号后获取 SENDKEY,消息会推送到你的微信。',
  },
  telegram: {
    label: 'Telegram',
    fields: [
      { key: 'token', label: 'Bot Token', placeholder: '123456:ABC-...' },
      { key: 'chat_id', label: 'Chat ID', placeholder: '给 bot 发条消息后用 @userinfobot 获取' },
    ],
    help: 'BotFather 创建 bot 拿 token;chat_id 可用 @userinfobot 获取。国内接收需科学上网。',
  },
  webhook: {
    label: '自定义 Webhook',
    fields: [{ key: 'url', label: 'Webhook URL', placeholder: 'https://...' }],
    help: '原样 POST {title, body, url} JSON,可对接 Bark / ntfy / PushPlus 等任意服务。',
  },
}

export const CHANNEL_TYPES: ChannelType[] = ['wecom', 'feishu', 'dingtalk', 'serverchan', 'telegram', 'webhook']

/** 拼接消息纯文本(标题 + 正文 + 链接) */
export function messageText(msg: NotifyMessage): string {
  return [msg.title, msg.body, msg.url].filter(Boolean).join('\n')
}

/**
 * 构造该渠道的请求(endpoint + JSON body);配置缺关键字段返回 null。
 * 钉钉/飞书的时间戳与签名在 worker 侧追加(需 crypto 与当前时间,不放进纯函数)。
 */
export function buildRequest(ch: NotifyChannel, msg: NotifyMessage): { url: string; body: Record<string, any> } | null {
  const c = ch.config || {}
  const text = messageText(msg)
  switch (ch.type) {
    case 'telegram':
      if (!c.token || !c.chat_id) return null
      return { url: `https://api.telegram.org/bot${c.token}/sendMessage`, body: { chat_id: c.chat_id, text } }
    case 'wecom':
      if (!c.webhook) return null
      return { url: c.webhook, body: { msgtype: 'text', text: { content: text } } }
    case 'feishu':
      if (!c.webhook) return null
      return { url: c.webhook, body: { msg_type: 'text', content: { text } } }
    case 'dingtalk':
      if (!c.webhook) return null
      return { url: c.webhook, body: { msgtype: 'text', text: { content: text } } }
    case 'serverchan':
      if (!c.sendkey) return null
      return { url: `https://sctapi.ftqq.com/${c.sendkey}.send`, body: { title: msg.title, desp: [msg.body, msg.url].filter(Boolean).join('\n\n') } }
    case 'webhook':
      if (!c.url) return null
      return { url: c.url, body: { title: msg.title, body: msg.body || '', url: msg.url || '' } }
    default:
      return null
  }
}
