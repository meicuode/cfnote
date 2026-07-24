// 笔记公开前的敏感信息扫描(纯函数,测试见 tests/sensitiveScan.test.ts)。
// 本应用是类 Evernote 个人笔记,常存账号密码/密钥/证件号等,转公开必须先全文体检:
// 返回所有疑似风险项(类型+行号+打码摘录),由确认弹窗全部列出,用户逐条确认后才可公开。

export interface SensitiveHit {
  /** 分类标识 */
  type: 'phone' | 'idcard' | 'bankcard' | 'email' | 'secret' | 'password' | 'privatekey'
  /** 中文标签(弹窗展示) */
  label: string
  /** 命中行的打码摘录 */
  excerpt: string
  /** 1-based 行号(第 1 行为标题时由调用方说明) */
  line: number
}

const MAX_HITS = 200

// Luhn 校验(银行卡号)
function luhn(digits: string): boolean {
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

// 身份证出生日期段合理性(降误报:任意 18 位数字不算)
function idcardDatePlausible(id: string): boolean {
  const y = Number(id.slice(6, 10))
  const m = Number(id.slice(10, 12))
  const d = Number(id.slice(12, 14))
  return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31
}

// 打码:保留头尾少量字符
function mask(v: string): string {
  if (v.length <= 4) return '****'
  if (v.length <= 8) return v.slice(0, 1) + '****' + v.slice(-1)
  return v.slice(0, 3) + '****' + v.slice(-2)
}

// 命中行摘录:命中值打码,过长行裁剪到命中附近
function makeExcerpt(lineText: string, matchStart: number, matchText: string): string {
  const masked = lineText.slice(0, matchStart) + mask(matchText) + lineText.slice(matchStart + matchText.length)
  const center = matchStart + Math.floor(matchText.length / 2)
  if (masked.length <= 80) return masked.trim()
  const from = Math.max(0, center - 40)
  const to = Math.min(masked.length, center + 40)
  return (from > 0 ? '…' : '') + masked.slice(from, to).trim() + (to < masked.length ? '…' : '')
}

interface Rule {
  type: SensitiveHit['type']
  label: string
  re: RegExp
  /** 额外校验,不通过则跳过该命中 */
  verify?: (m: RegExpExecArray) => boolean
}

// 顺序即优先级:同一段文字被更高优先级规则命中后,低优先级不再重复报
const RULES: Rule[] = [
  { type: 'privatekey', label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { type: 'secret', label: 'AWS AccessKey', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'secret', label: 'API Key(sk-)', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { type: 'secret', label: 'GitHub Token', re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g },
  { type: 'secret', label: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'secret', label: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { type: 'secret', label: 'JWT 令牌', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  {
    type: 'secret',
    label: '疑似密钥赋值',
    re: /(?:api[_-]?key|apikey|access[_-]?key|secret|token|密钥|访问令牌)\s*[:=：]\s*["']?([A-Za-z0-9_\-./+=]{8,})/gi,
  },
  {
    type: 'password',
    label: '疑似密码',
    // 要求显式分隔(冒号/等号/是/为),避免叙述文字中出现"密码"二字即误报
    re: /(?:密码|口令|password|passwd|pwd)\s*(?:[:=：]|是|为)\s*["']?(\S{4,})/gi,
  },
  {
    type: 'idcard',
    label: '身份证号',
    re: /(?<!\d)\d{17}[\dXx](?!\d)/g,
    verify: (m) => idcardDatePlausible(m[0]),
  },
  { type: 'phone', label: '手机号', re: /(?<![\dA-Za-z])1[3-9]\d{9}(?!\d)/g },
  {
    type: 'bankcard',
    label: '银行卡号(疑似)',
    re: /(?<!\d)[1-9]\d{12,18}(?!\d)/g,
    verify: (m) => m[0].length >= 13 && luhn(m[0]),
  },
  { type: 'email', label: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
]

export function scanSensitive(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = []
  const lines = (text || '').split('\n')
  for (let i = 0; i < lines.length && hits.length < MAX_HITS; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    // 已被更高优先级规则命中的区间,低优先级不再重复报(如身份证 vs 银行卡)
    const claimed: Array<[number, number]> = []
    const overlaps = (s: number, e: number) => claimed.some(([cs, ce]) => s < ce && e > cs)
    for (const rule of RULES) {
      rule.re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = rule.re.exec(line)) !== null && hits.length < MAX_HITS) {
        const s = m.index
        const e = m.index + m[0].length
        if (overlaps(s, e)) continue
        if (rule.verify && !rule.verify(m)) continue
        claimed.push([s, e])
        hits.push({
          type: rule.type,
          label: rule.label,
          excerpt: makeExcerpt(line, s, m[0]),
          line: i + 1,
        })
        if (m.index === rule.re.lastIndex) rule.re.lastIndex++
      }
    }
  }
  return hits
}
