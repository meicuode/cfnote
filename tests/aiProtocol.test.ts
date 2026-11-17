import { describe, it, expect } from 'vitest'
import {
  buildChatBody, alternateTurns, createThinkSplitter, createSseDecoder, parseCompletion, classifyProbe,
  redactKey, upstreamMessage, joinThink, workersAiToken, cleanChatMessages,
  type ChatMessage, type StreamChunk,
} from '../src/lib/aiProtocol'

const msgs: ChatMessage[] = [
  { role: 'system', content: 'SYS' },
  { role: 'user', content: 'hi' },
]

describe('buildChatBody', () => {
  it('Chat:effort 只在 openai 方式下发;不带 max_tokens;流式带 include_usage', () => {
    const b = buildChatBody({ protocol: 'openai-chat', model: 'o3', messages: msgs, effort: 'high', scheme: 'openai', stream: true })
    expect(b).toEqual({ model: 'o3', messages: msgs, stream: true, reasoning_effort: 'high', stream_options: { include_usage: true } })
    const plain = buildChatBody({ protocol: 'openai-chat', model: 'gpt-4o', messages: msgs, effort: 'high', scheme: 'none', stream: false })
    expect(plain).toEqual({ model: 'gpt-4o', messages: msgs, stream: false })
  })

  it('Responses:system → instructions,store:false,reasoning 带 summary', () => {
    const b = buildChatBody({ protocol: 'openai-responses', model: 'gpt-5', messages: msgs, effort: 'low', scheme: 'openai', stream: true })
    expect(b).toEqual({
      model: 'gpt-5', input: [{ role: 'user', content: 'hi' }], stream: true, store: false,
      instructions: 'SYS', reasoning: { effort: 'low', summary: 'auto' },
    })
    const brief = buildChatBody({ protocol: 'openai-responses', model: 'gpt-5', messages: msgs, scheme: 'openai', stream: false, brief: true })
    expect(brief.max_output_tokens).toBe(1024)
    expect(brief.reasoning).toBeUndefined()
  })

  it('Anthropic adaptive:thinking + output_config.effort + display summarized,max_tokens 给足', () => {
    const b = buildChatBody({ protocol: 'anthropic', model: 'claude-opus-4-7', messages: msgs, effort: 'xhigh', scheme: 'anthropic-adaptive', stream: true })
    expect(b).toEqual({
      model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }], stream: true, max_tokens: 32000, system: 'SYS',
      thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: 'xhigh' },
    })
  })

  it('Anthropic adaptive 不选档位:不发 thinking,但 max_tokens 仍给足(Claude 5 默认也会思考)', () => {
    const b = buildChatBody({ protocol: 'anthropic', model: 'claude-opus-5-5', messages: msgs, effort: '', scheme: 'anthropic-adaptive', stream: true })
    expect(b.thinking).toBeUndefined()
    expect(b.output_config).toBeUndefined()
    expect(b.max_tokens).toBe(32000)
  })

  it('Anthropic budget:档位换算成 budget_tokens,max_tokens 比预算大', () => {
    const b = buildChatBody({ protocol: 'anthropic', model: 'claude-sonnet-4-5', messages: msgs, effort: 'high', scheme: 'anthropic-budget', stream: true })
    expect(b.thinking).toEqual({ type: 'enabled', budget_tokens: 16000 })
    expect(b.max_tokens).toBe(16000 + 4096)
    const brief = buildChatBody({ protocol: 'anthropic', model: 'claude-sonnet-4-5', messages: msgs, effort: 'high', scheme: 'anthropic-budget', stream: false, brief: true })
    expect(brief.thinking).toEqual({ type: 'enabled', budget_tokens: 1024 })
    expect(brief.max_tokens).toBe(2048)
  })

  it('Anthropic 不思考:max_tokens 4096(Claude 3 Haiku 的上限);探测时压到 1024', () => {
    expect(buildChatBody({ protocol: 'anthropic', model: 'claude-3-haiku', messages: msgs, scheme: 'none', stream: true }).max_tokens).toBe(4096)
    expect(buildChatBody({ protocol: 'anthropic', model: 'claude-3-haiku', messages: msgs, scheme: 'none', stream: false, brief: true }).max_tokens).toBe(1024)
  })
})

describe('alternateTurns', () => {
  it('去掉 system 与空消息,丢弃开头的 assistant,合并连续同角色', () => {
    const out = alternateTurns([
      { role: 'system', content: 's' },
      { role: 'assistant', content: '开场白' },
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: '  ' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ])
    expect(out).toEqual([
      { role: 'user', content: 'a\n\nb' },
      { role: 'assistant', content: 'c' },
      { role: 'user', content: 'd' },
    ])
  })
})
/** 把一串事件归并成 think / text / 最后一次 usage,断言时不关心切成了几段 */
function fold(chunks: StreamChunk[]) {
  let think = ''
  let text = ''
  let usage: any
  for (const c of chunks) {
    if (c.type === 'think') think += c.text
    else if (c.type === 'text') text += c.text
    else usage = c.usage
  }
  return { think, text, usage }
}

function split(implicit: boolean, toks: string[]) {
  const s = createThinkSplitter(implicit)
  return fold([...toks.flatMap((t) => s.push(t)), ...s.end()])
}

describe('createThinkSplitter', () => {
  it('显式 <think>…</think>,标签被拆在任意位置', () => {
    expect(split(false, ['<thi', 'nk>想', '一想</th', 'ink>\n\n答案'])).toEqual({ think: '想一想', text: '答案', usage: undefined })
  })

  it('显式模式下普通回答原样当正文(不会被吞成思考)', () => {
    expect(split(false, ['  ', '你好', '</think>不是标签'])).toEqual({ think: '', text: '  你好</think>不是标签', usage: undefined })
  })

  it('implicit:开头漏掉 <think> 也能拆(QwQ 的老毛病)', () => {
    expect(split(true, ['先想', '想</think>', '  结论'])).toEqual({ think: '先想想', text: '结论', usage: undefined })
  })

  it('implicit:到结束都没有 </think>,全部算思考', () => {
    expect(split(true, ['一直', '在想'])).toEqual({ think: '一直在想', text: '', usage: undefined })
  })

  it('思考段尾部留住 </think> 的长度再下发,不会把半个标签当思考发出去', () => {
    const s = createThinkSplitter(false)
    // 'abcdefghijkl</' 共 14 字符,留住末尾 8 个,先下发 6 个
    expect(fold(s.push('<think>abcdefghijkl</'))).toEqual({ think: 'abcdef', text: '', usage: undefined })
    expect(fold([...s.push('think>ok'), ...s.end()])).toEqual({ think: 'ghijkl', text: 'ok', usage: undefined })
  })
})
/** 把整段 SSE 文本按 n 字符切开逐段喂进去:网络 chunk 会在任意位置切断一行 */
function decode(protocol: 'openai-chat' | 'openai-responses' | 'anthropic', sse: string, n = 7) {
  const d = createSseDecoder(protocol)
  const out: StreamChunk[] = []
  for (let i = 0; i < sse.length; i += n) out.push(...d.push(sse.slice(i, i + n)))
  out.push(...d.end())
  return fold(out)
}

const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

describe('createSseDecoder', () => {
  it('Chat:reasoning_content + content + 末尾 usage,注释行与 [DONE] 跳过', () => {
    const sse = data({ choices: [{ delta: { reasoning_content: '想' } }] })
      + data({ choices: [{ delta: { content: '答' } }] })
      + ': keep-alive\n\n'
      + data({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, completion_tokens_details: { reasoning_tokens: 3 } } })
      + 'data: [DONE]\n\n'
    expect(decode('openai-chat', sse)).toEqual({ think: '想', text: '答', usage: { input: 10, output: 5, reasoning: 3 } })
  })

  it('Chat:OpenRouter 的 reasoning 字段;正文里内联的 <think> 也拆', () => {
    expect(decode('openai-chat', data({ choices: [{ delta: { reasoning: 'R' } }] }) + data({ choices: [{ delta: { content: 'A' } }] })))
      .toEqual({ think: 'R', text: 'A', usage: undefined })
    expect(decode('openai-chat', data({ choices: [{ delta: { content: '<think>x</think>y' } }] }), 3))
      .toEqual({ think: 'x', text: 'y', usage: undefined })
  })

  it('Chat:流中途的 error 对象直接抛', () => {
    expect(() => decode('openai-chat', data({ error: { message: 'quota exceeded' } }))).toThrow('quota exceeded')
  })

  it('Chat:最后一行没有换行也不丢', () => {
    const d = createSseDecoder('openai-chat')
    expect(d.push('data: {"choices":[{"delta":{"content":"尾"}}]}')).toEqual([])
    expect(fold(d.end()).text).toBe('尾')
  })

  it('Responses:思考摘要多段之间补空行,completed 里取 usage', () => {
    const sse = 'event: response.reasoning_summary_part.added\n' + data({ type: 'response.reasoning_summary_part.added' })
      + data({ type: 'response.reasoning_summary_text.delta', delta: 'A' })
      + data({ type: 'response.reasoning_summary_part.added' })
      + data({ type: 'response.reasoning_summary_text.delta', delta: 'B' })
      + data({ type: 'response.output_text.delta', delta: '答' })
      + data({ type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 9, output_tokens_details: { reasoning_tokens: 4 } } } })
    expect(decode('openai-responses', sse)).toEqual({ think: 'A\n\nB', text: '答', usage: { input: 7, output: 9, reasoning: 4 } })
  })

  it('Responses:response.failed 和 error 事件抛出上游的原话', () => {
    expect(() => decode('openai-responses', data({ type: 'response.failed', response: { error: { message: 'bad model' } } }))).toThrow('bad model')
    expect(() => decode('openai-responses', data({ type: 'error', message: 'rate limited' }))).toThrow('rate limited')
  })

  it('Anthropic:thinking_delta / text_delta,签名与 ping 忽略,usage 合并(输入含缓存)', () => {
    const sse = data({ type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 1 } } })
      + data({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } })
      + data({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '嗯' } })
      + data({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'xx' } })
      + data({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '好' } })
      + data({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } })
      + data({ type: 'ping' })
    expect(decode('anthropic', sse)).toEqual({ think: '嗯', text: '好', usage: { input: 8, output: 12 } })
  })

  it('Anthropic:error 事件抛出', () => {
    expect(() => decode('anthropic', data({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }))).toThrow('Overloaded')
  })
})
describe('parseCompletion', () => {
  it('Anthropic:thinking 块哪怕内容被省略也算思考了', () => {
    const c = parseCompletion('anthropic', {
      content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: ' 38 ' }],
      usage: { input_tokens: 20, output_tokens: 300 },
    })
    expect(c).toEqual({ text: '38', think: '', usage: { input: 20, output: 300 }, reasoningSeen: true })
    expect(parseCompletion('anthropic', { content: [{ type: 'text', text: 'OK' }] }).reasoningSeen).toBe(false)
  })

  it('Responses:按 reasoning_tokens 判,不按有没有 reasoning 项(minimal 档也会带一个空项)', () => {
    const base = { output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: 'OK' }] }] }
    expect(parseCompletion('openai-responses', { ...base, usage: { output_tokens_details: { reasoning_tokens: 0 } } }).reasoningSeen).toBe(false)
    expect(parseCompletion('openai-responses', { ...base, usage: { output_tokens_details: { reasoning_tokens: 64 } } }).reasoningSeen).toBe(true)
    const withSummary = parseCompletion('openai-responses', { output: [{ type: 'reasoning', summary: [{ text: '先算 7' }, { text: '再算 11' }] }] })
    expect(withSummary.think).toBe('先算 7\n\n再算 11')
    expect(withSummary.reasoningSeen).toBe(true)
  })

  it('Chat:reasoning_content、reasoning_tokens、正文开头的 <think> 都算', () => {
    expect(parseCompletion('openai-chat', { choices: [{ message: { content: '38', reasoning_content: '算' } }] }).reasoningSeen).toBe(true)
    expect(parseCompletion('openai-chat', { choices: [{ message: { content: '38' } }], usage: { completion_tokens_details: { reasoning_tokens: 9 } } }).reasoningSeen).toBe(true)
    const inline = parseCompletion('openai-chat', { choices: [{ message: { content: '<think>算一下</think>\n38' } }] })
    expect(inline).toMatchObject({ think: '算一下', text: '38', reasoningSeen: true })
    expect(parseCompletion('openai-chat', { choices: [{ message: { content: 'OK' } }] }).reasoningSeen).toBe(false)
  })

  it('200 里裹着 error 的照样抛;不是对象的抛', () => {
    expect(() => parseCompletion('openai-chat', { error: { message: 'no channel available' } })).toThrow('no channel available')
    expect(() => parseCompletion('anthropic', { type: 'error', error: { message: 'x' } })).toThrow('x')
    expect(() => parseCompletion('openai-chat', 'nope')).toThrow()
  })
})

describe('classifyProbe', () => {
  const think = { text: '38', think: '…', usage: {}, reasoningSeen: true }
  const plain = { ...think, think: '', reasoningSeen: false }

  it('只有 400 / 422 算拒绝;鉴权、限流、5xx、网络错误都是 error', () => {
    expect(classifyProbe(400, null)).toBe('rejected')
    expect(classifyProbe(422, null)).toBe('rejected')
    for (const s of [0, 401, 403, 404, 408, 429, 500, 502, 503]) expect(classifyProbe(s, null), String(s)).toBe('error')
  })

  it('2xx 按有没有思考分成 effective / accepted;2xx 但没解析出结果算 error', () => {
    expect(classifyProbe(200, think)).toBe('effective')
    expect(classifyProbe(200, plain)).toBe('accepted')
    expect(classifyProbe(200, null)).toBe('error')
  })
})

describe('redactKey', () => {
  const key = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX1234'

  it('整串出现时替换', () => {
    expect(redactKey(`invalid key: ${key} (code 401)`, key)).toBe('invalid key: **** (code 401)')
  })

  it('只回显了一截(≥12 字符)也替换', () => {
    const out = redactKey('token sk-ABCDEFGHIJKL... is invalid', key)
    expect(out).not.toContain('ABCDEFGHIJKL')
    expect(out).toContain('****')
  })

  it('短于 12 字符的残段、和 Key 无关的文字不动;太短的 Key 不处理', () => {
    expect(redactKey('sk-ABCDE is short', key)).toBe('sk-ABCDE is short')
    expect(redactKey('nothing here', key)).toBe('nothing here')
    expect(redactKey('abc abc', 'abc')).toBe('abc abc')
  })
})

describe('其他小工具', () => {
  it('upstreamMessage 认几种常见的报错结构', () => {
    expect(upstreamMessage({ error: { message: 'a' } })).toBe('a')
    expect(upstreamMessage({ error: 'b' })).toBe('b')
    expect(upstreamMessage({ message: 'c' })).toBe('c')
    expect(upstreamMessage({ detail: 'd' })).toBe('d')
    expect(upstreamMessage({ detail: [{ loc: 'x' }] })).toBe('')
    expect(upstreamMessage(null)).toBe('')
  })

  it('joinThink 与 P8 起的落库格式一致', () => {
    expect(joinThink('想', '答')).toBe('<think>想</think>答')
    expect(joinThink('', '答')).toBe('答')
  })

  it('workersAiToken 只取 response 字段', () => {
    expect(workersAiToken('data: {"response":"你"}')).toBe('你')
    expect(workersAiToken('data: [DONE]')).toBe('')
    expect(workersAiToken('data: {bad')).toBe('')
    expect(workersAiToken('data: {"response":"","usage":{}}')).toBe('')
    expect(workersAiToken('event: x')).toBe('')
  })

  it('cleanChatMessages:只收 user / assistant,最后一条是非空的 user,数量与长度有上限', () => {
    const ok = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]
    expect(cleanChatMessages(ok)).toEqual(ok)
    expect(cleanChatMessages([{ role: 'system', content: 'x' }, { role: 'user', content: 'a' }])).toBeNull()
    expect(cleanChatMessages([{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }])).toBeNull()
    expect(cleanChatMessages([{ role: 'user', content: '  ' }])).toBeNull()
    expect(cleanChatMessages([])).toBeNull()
    expect(cleanChatMessages('x')).toBeNull()
    expect(cleanChatMessages(Array.from({ length: 41 }, () => ({ role: 'user', content: 'a' })))).toBeNull()
    expect(cleanChatMessages([{ role: 'user', content: 'a'.repeat(60001) }])).toBeNull()
    expect(cleanChatMessages([{ role: 'user', content: 1 }])).toBeNull()
  })
})
