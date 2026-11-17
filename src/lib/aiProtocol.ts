// 外部 AI 渠道的「线上格式」(P19):三种协议的请求体构造、SSE 解析、非流式结果解析、
// 探测结果判定、上游报错里的 Key 打码。纯函数,不发请求——fetch 在 worker/llm.ts,
// 这样 fetch 可以注入,单测不依赖测试框架的 fetch mock。

import type { AiProtocol, Effort, EffortScheme, ProbeOutcome } from './aiProviders'
import { MASK_PREFIX } from './notifyChannels'

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface Usage { input?: number; output?: number; reasoning?: number }
export type StreamChunk =
  | { type: 'think'; text: string }
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: Usage }

// Anthropic 必须带 max_tokens(OpenAI 兼容协议不带:有的模型只认 max_completion_tokens,发错名字直接 400)。
// 思考 token 也算在 max_tokens 里,所以开思考时要给足:adaptive 一律 32000(4.6 以后的模型输出上限都 ≥64k),
// budget 方式是预算加 4096 留给正文。不开思考是 4096——Claude 3 Haiku 的输出上限就是 4096。
const ANTHROPIC_MAX_TOKENS = 4096
const ADAPTIVE_MAX_TOKENS = 32000
const BUDGET_TOKENS: Partial<Record<Effort, number>> = { low: 2048, medium: 8192, high: 16000 }
const BUDGET_HEADROOM = 4096
// 可用性测试与思考探测只看「能不能通、有没有思考」,不需要完整答案。
// 思考被截断时返回里照样有 thinking 块 / reasoning_tokens,判定不受影响。budget 的下限是 1024
const BRIEF_MAX_TOKENS = 1024
const BRIEF_BUDGET = 1024

// 探测用的题:要算一下才答得出(答案 38),让支持思考的模型真的进入思考。
// 题太简单的话,模型可能直接作答,结果就成了 accepted 而不是 effective
export const PROBE_PROMPT = '找出最小的正整数 x,使得 x 除以 7 余 3,且 x 除以 11 余 5。只回答这个数字。'
export const PING_PROMPT = 'Reply with OK.'

export interface ChatBodyInput {
  protocol: AiProtocol
  model: string
  messages: ChatMessage[]
  effort?: Effort | ''
  scheme: EffortScheme
  stream: boolean
  /** 可用性测试 / 探测:压低 max_tokens 省 token */
  brief?: boolean
}
/** 按协议构造请求体。effort 为空 = 不发思考参数,由上游用它自己的默认值 */
export function buildChatBody(i: ChatBodyInput): Record<string, unknown> {
  const effort = i.effort || ''
  if (i.protocol === 'openai-chat') {
    const body: Record<string, unknown> = { model: i.model, messages: i.messages, stream: i.stream }
    if (effort && i.scheme === 'openai') body.reasoning_effort = effort
    if (i.stream) body.stream_options = { include_usage: true }
    return body
  }
  if (i.protocol === 'openai-responses') {
    const system = i.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
    const body: Record<string, unknown> = {
      model: i.model,
      input: i.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      stream: i.stream,
      // Responses 默认 store:true,会在 OpenAI 那边留存 30 天。发出去的是知识库片段,没理由让它多留一份
      store: false,
    }
    if (system) body.instructions = system
    // summary:'auto' 才拿得到思考摘要;不带的话 reasoning 照样跑,但流里看不到思考内容
    if (effort && i.scheme === 'openai') body.reasoning = { effort, summary: 'auto' }
    if (i.brief) body.max_output_tokens = BRIEF_MAX_TOKENS
    return body
  }
  // anthropic
  const system = i.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')
  const body: Record<string, unknown> = {
    model: i.model,
    messages: alternateTurns(i.messages),
    stream: i.stream,
    max_tokens: ANTHROPIC_MAX_TOKENS,
  }
  if (system) body.system = system
  // adaptive 档的模型不管发不发 effort 都给足 max_tokens:Claude 5 系列不带 thinking 参数时默认也会思考
  if (i.scheme === 'anthropic-adaptive') body.max_tokens = i.brief ? BRIEF_MAX_TOKENS : ADAPTIVE_MAX_TOKENS
  if (effort && i.scheme === 'anthropic-adaptive') {
    // display:'summarized':Claude 5 系列默认 omitted,不写的话思考照样计费,但返回里只有空的 thinking 块
    body.thinking = { type: 'adaptive', display: 'summarized' }
    body.output_config = { effort }
  } else if (effort && i.scheme === 'anthropic-budget') {
    const budget = i.brief ? BRIEF_BUDGET : (BUDGET_TOKENS[effort] ?? BUDGET_TOKENS.medium!)
    body.thinking = { type: 'enabled', budget_tokens: budget }
    // max_tokens 必须大于 budget_tokens
    body.max_tokens = budget + (i.brief ? BRIEF_MAX_TOKENS : BUDGET_HEADROOM)
  } else if (i.brief) {
    body.max_tokens = BRIEF_MAX_TOKENS
  }
  return body
}

/**
 * Messages API 要求 user / assistant 严格交替、第一条是 user;system 走顶层字段。
 * 重新生成之类的路径可能留下连续两条同角色消息,这里合并掉;空内容的消息上游会 400,也丢掉。
 */
export function alternateTurns(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string }[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role === 'system' || !m.content.trim()) continue
    if (out.length === 0 && m.role !== 'user') continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) last.content += '\n\n' + m.content
    else out.push({ role: m.role, content: m.content })
  }
  return out
}
// ---- 正文里的 <think> 标签 ----

const OPEN = '<think>'
const CLOSE = '</think>'

/**
 * 把正文里内联的 <think>…</think> 拆成 think / text 两路(R1、QwQ 这类模型的输出格式)。
 * - implicit=true:已知是推理模型,开头的 <think> 可能被漏掉,一开始就当思考,直到 </think>
 *   (这是 P8 以来 conversations.ts 里那个状态机,原样挪过来)
 * - implicit=false:只有正文确实以 <think> 开头才进思考;外部渠道一律用这个,别把普通回答吞成思考
 * </think> 可能被拆在两个 token 里,所以思考段的尾部要留住 CLOSE.length 个字符再下发。
 */
export function createThinkSplitter(implicit: boolean) {
  let phase: 'detect' | 'think' | 'text' = 'detect'
  let buf = ''
  let lead = false // 刚出思考段:正文开头的空白丢掉

  const emitText = (s: string, out: StreamChunk[]) => {
    if (lead) { s = s.replace(/^\s+/, ''); if (s) lead = false }
    if (s) out.push({ type: 'text', text: s })
  }
  const drainThink = (out: StreamChunk[]) => {
    const idx = buf.indexOf(CLOSE)
    if (idx >= 0) {
      if (idx > 0) out.push({ type: 'think', text: buf.slice(0, idx) })
      const rest = buf.slice(idx + CLOSE.length)
      buf = ''
      phase = 'text'
      lead = true
      emitText(rest, out)
    } else if (buf.length > CLOSE.length) {
      out.push({ type: 'think', text: buf.slice(0, -CLOSE.length) })
      buf = buf.slice(-CLOSE.length)
    }
  }

  return {
    push(tok: string): StreamChunk[] {
      const out: StreamChunk[] = []
      if (!tok) return out
      if (phase === 'text') { emitText(tok, out); return out }
      buf += tok
      if (phase === 'detect') {
        const t = buf.trimStart()
        if (t.startsWith(OPEN)) { buf = t.slice(OPEN.length); phase = 'think' }
        else if (t.length === 0 || OPEN.startsWith(t)) return out // 还不足以判断,继续攒
        else if (implicit) phase = 'think'
        else { phase = 'text'; const s = buf; buf = ''; emitText(s, out); return out }
      }
      drainThink(out)
      return out
    },
    end(): StreamChunk[] {
      const out: StreamChunk[] = []
      if (buf) {
        if (phase === 'think' || (phase === 'detect' && implicit)) out.push({ type: 'think', text: buf })
        else emitText(buf, out)
      }
      buf = ''
      return out
    },
  }
}
// ---- SSE 解析 ----

/**
 * 三种协议的流式响应 → 统一的 think / text / usage 事件。
 * 网络 chunk 可能在任意位置切断一行,所以按行缓冲;只看 data: 行(三家的事件类型都在 JSON 里,
 * event: 行不用看)。上游在流中途报错时直接 throw,由调用方转成 SSE error 事件。
 * 正文里内联的 <think> 也在这里拆(有的中转站把 R1 的思考塞在正文里转发)。
 */
export function createSseDecoder(protocol: AiProtocol) {
  let buf = ''
  let usage: Usage = {}
  let summaryParts = 0
  const splitter = createThinkSplitter(false)

  const addUsage = (u: Usage | null, out: StreamChunk[]) => {
    if (!u) return
    usage = { ...usage, ...dropUndefined(u) }
    out.push({ type: 'usage', usage })
  }

  const onChat = (j: any, out: StreamChunk[]) => {
    if (j.error) throw new Error(upstreamMessage(j) || '上游返回错误')
    const d = j.choices?.[0]?.delta
    if (d) {
      // DeepSeek / 硅基流动 / 多数中转站用 reasoning_content,OpenRouter 用 reasoning
      const r = d.reasoning_content ?? d.reasoning
      if (typeof r === 'string' && r) out.push({ type: 'think', text: r })
      if (typeof d.content === 'string' && d.content) out.push(...splitter.push(d.content))
    }
    if (j.usage) addUsage(openaiUsage(j.usage), out)
  }

  const onResponses = (j: any, out: StreamChunk[]) => {
    switch (j.type) {
      case 'response.output_text.delta':
        if (typeof j.delta === 'string') out.push(...splitter.push(j.delta))
        break
      case 'response.reasoning_summary_part.added':
        // 摘要分好几段时段间补个空行,不然几段话首尾粘在一起
        if (summaryParts++ > 0) out.push({ type: 'think', text: '\n\n' })
        break
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (typeof j.delta === 'string' && j.delta) out.push({ type: 'think', text: j.delta })
        break
      case 'response.completed':
      case 'response.incomplete':
        if (j.response?.usage) addUsage(openaiUsage(j.response.usage), out)
        break
      case 'response.failed':
        throw new Error(upstreamMessage(j.response) || '上游生成失败')
      case 'error':
        throw new Error(upstreamMessage(j) || '上游返回错误')
    }
  }

  const onAnthropic = (j: any, out: StreamChunk[]) => {
    switch (j.type) {
      case 'content_block_delta': {
        const d = j.delta
        if (d?.type === 'text_delta' && typeof d.text === 'string') out.push(...splitter.push(d.text))
        else if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) out.push({ type: 'think', text: d.thinking })
        break
      }
      case 'message_start':
        if (j.message?.usage) addUsage(anthropicUsage(j.message.usage), out)
        break
      case 'message_delta':
        if (j.usage) addUsage(anthropicUsage(j.usage), out)
        break
      case 'error':
        throw new Error(upstreamMessage(j) || '上游返回错误')
    }
  }

  const onLine = (line: string, out: StreamChunk[]) => {
    const l = line.trim()
    if (!l.startsWith('data:')) return
    const data = l.slice(5).trim()
    if (!data || data === '[DONE]') return
    let j: any
    try { j = JSON.parse(data) } catch { return } // 半截或非 JSON 的行跳过,和 Workers AI 那边一样
    if (protocol === 'anthropic') onAnthropic(j, out)
    else if (protocol === 'openai-responses') onResponses(j, out)
    else onChat(j, out)
  }

  return {
    push(chunk: string): StreamChunk[] {
      const out: StreamChunk[] = []
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) onLine(line, out)
      return out
    },
    end(): StreamChunk[] {
      const out: StreamChunk[] = []
      if (buf) onLine(buf, out)
      buf = ''
      out.push(...splitter.end())
      return out
    },
  }
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function dropUndefined(u: Usage): Usage {
  const o: Usage = {}
  if (u.input !== undefined) o.input = u.input
  if (u.output !== undefined) o.output = u.output
  if (u.reasoning !== undefined) o.reasoning = u.reasoning
  return o
}

/** Chat 用 prompt/completion_tokens,Responses 用 input/output_tokens;思考 token 在各自的 details 里 */
function openaiUsage(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null
  return {
    input: num(u.prompt_tokens ?? u.input_tokens),
    output: num(u.completion_tokens ?? u.output_tokens),
    reasoning: num(u.completion_tokens_details?.reasoning_tokens ?? u.output_tokens_details?.reasoning_tokens),
  }
}

/** Anthropic 的输入 token 分成三份(未命中缓存 / 写缓存 / 读缓存),加起来才是总输入 */
function anthropicUsage(u: any): Usage | null {
  if (!u || typeof u !== 'object') return null
  const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(num)
  const input = parts.every((p) => p === undefined) ? undefined : parts.reduce<number>((a, b) => a + (b ?? 0), 0)
  return { input, output: num(u.output_tokens) }
}

/** 从各家五花八门的报错结构里取一句人话。OpenAI / Anthropic 是 error.message,中转站常见 message / detail / msg */
export function upstreamMessage(j: any): string {
  if (!j || typeof j !== 'object') return ''
  const e = j.error
  const m = typeof e === 'string' ? e
    : typeof e?.message === 'string' ? e.message
    : typeof j.message === 'string' ? j.message
    : typeof j.detail === 'string' ? j.detail
    : typeof j.msg === 'string' ? j.msg
    : ''
  return m.slice(0, 500)
}

// ---- 非流式结果(可用性测试 / 思考探测) ----

export interface Completion {
  text: string
  think: string
  usage: Usage
  /** 是否确实发生了思考:有思考文本、thinking 块(哪怕内容被省略),或 reasoning_tokens > 0 */
  reasoningSeen: boolean
}

export function parseCompletion(protocol: AiProtocol, json: unknown): Completion {
  const j: any = json
  if (!j || typeof j !== 'object') throw new Error('上游返回的不是 JSON 对象')
  if (j.error || j.type === 'error') throw new Error(upstreamMessage(j) || '上游返回错误')
  let text = ''
  let think = ''
  let sawBlock = false
  let usage: Usage = {}
  if (protocol === 'anthropic') {
    for (const b of Array.isArray(j.content) ? j.content : []) {
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text
      else if (b?.type === 'thinking' || b?.type === 'redacted_thinking') {
        sawBlock = true
        if (typeof b.thinking === 'string') think += b.thinking
      }
    }
    usage = anthropicUsage(j.usage) ?? {}
  } else if (protocol === 'openai-responses') {
    for (const item of Array.isArray(j.output) ? j.output : []) {
      if (item?.type === 'message') {
        for (const c of Array.isArray(item.content) ? item.content : []) {
          if (c?.type === 'output_text' && typeof c.text === 'string') text += c.text
        }
      } else if (item?.type === 'reasoning') {
        for (const s of Array.isArray(item.summary) ? item.summary : []) {
          if (typeof s?.text === 'string') think += (think ? '\n\n' : '') + s.text
        }
      }
    }
    // gpt-5 的 minimal 档也会带一个空的 reasoning 项,不能拿「有 reasoning 项」当思考了的证据,只看 token 数
    usage = openaiUsage(j.usage) ?? {}
  } else {
    const msg = j.choices?.[0]?.message ?? {}
    if (typeof msg.content === 'string') text = msg.content
    const r = msg.reasoning_content ?? msg.reasoning
    if (typeof r === 'string') think = r
    if (!think && text.trimStart().startsWith(OPEN)) {
      const t = text.trimStart()
      const end = t.indexOf(CLOSE)
      think = end >= 0 ? t.slice(OPEN.length, end) : t.slice(OPEN.length)
      text = end >= 0 ? t.slice(end + CLOSE.length) : ''
    }
    usage = openaiUsage(j.usage) ?? {}
  }
  usage = dropUndefined(usage)
  const reasoningSeen = think.trim().length > 0 || sawBlock || (usage.reasoning ?? 0) > 0
  return { text: text.trim(), think: think.trim(), usage, reasoningSeen }
}
// ---- 探测判定 ----

/**
 * 只有 400 / 422 算「拒绝」:那是上游明确说参数不对。401 / 403 / 404 / 408 / 429 / 5xx / 超时 / 网络错误
 * 都与思考参数无关,记为 error,不能因为一次限流就把这一档判成不支持。
 * 2xx 再按返回里有没有思考分成 accepted / effective。
 */
export function classifyProbe(status: number, completion: Completion | null): ProbeOutcome {
  if (status === 400 || status === 422) return 'rejected'
  if (status < 200 || status >= 300 || !completion) return 'error'
  return completion.reasoningSeen ? 'effective' : 'accepted'
}

// ---- Key 打码 ----

const KEY_WINDOW = 12

/**
 * 上游报错文本在返回给前端、写 system_logs 之前先过一遍:部分中转站会在报错里回显 Key
 * (「invalid key: sk-xxxx」),有的只回显前后一截。整串替换,再按 12 字符的窗口找残段。
 * 太短的 Key 不处理——那样会把正常文字误伤成一堆掩码,而这么短的 Key 也谈不上泄露风险。
 */
export function redactKey(text: string, key: string): string {
  if (!text || !key || key.length < 8) return text
  let out = text.split(key).join(MASK_PREFIX)
  if (key.length > KEY_WINDOW) {
    for (let i = 0; i + KEY_WINDOW <= key.length; i++) {
      const frag = key.slice(i, i + KEY_WINDOW)
      if (out.includes(frag)) out = out.split(frag).join(MASK_PREFIX)
    }
  }
  return out
}

// ---- 其他 ----

/** 落库格式:有思考时 `<think>思考</think>正文`,与 P8 起的消息格式一致,前端 parseThink 照旧能拆 */
export function joinThink(think: string, text: string): string {
  return think ? `${OPEN}${think}${CLOSE}${text}` : text
}

/** Workers AI 的 SSE 一行:data: {"response":"…"};[DONE] / 空行 / 坏行返回空串 */
export function workersAiToken(line: string): string {
  const l = line.trim()
  if (!l.startsWith('data:')) return ''
  const data = l.slice(5).trim()
  if (!data || data === '[DONE]') return ''
  try {
    const j: any = JSON.parse(data)
    return typeof j?.response === 'string' ? j.response : ''
  } catch {
    return ''
  }
}

const MAX_TEST_MESSAGES = 40
const MAX_TEST_CHARS = 60000

/** 对话测试弹窗发来的消息:只收 user / assistant,最后一条必须是 user,总长有上限 */
export function cleanChatMessages(v: unknown): { role: 'user' | 'assistant'; content: string }[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_TEST_MESSAGES) return null
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  let total = 0
  for (const m of v) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return null
    total += m.content.length
    if (total > MAX_TEST_CHARS) return null
    out.push({ role: m.role, content: m.content })
  }
  if (out[out.length - 1].role !== 'user' || !out[out.length - 1].content.trim()) return null
  return out
}
