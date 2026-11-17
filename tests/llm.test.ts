import { describe, it, expect } from 'vitest'
import {
  streamChat, completeChat, requestCompletion, fetchModels, makeTarget, modelLabel, allowPrivate,
  type ProviderRow, type FetchFn,
} from '../worker/llm'
import type { StreamChunk } from '../src/lib/aiProtocol'

// worker/llm.ts 的适配器。fetch 是注入的,不起网络也不依赖测试框架的 fetch mock;
// 需要 D1 的部分(resolveTarget、findModelEntry、validateLlmSettings)在 tests/worker/aiProviders.test.ts。

const KEY = 'sk-test-0123456789abcdefghij'

function provider(over: Partial<ProviderRow> = {}): ProviderRow {
  return { id: 7, name: '中转', mode: 'relay', protocol: 'openai-chat', base_url: 'https://relay.test/v1', api_key: KEY, allow_private: 0, ...over }
}

function streamOf(chunks: string[], onCancel?: () => void): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  let i = 0
  return new ReadableStream({
    pull(ctrl) {
      if (i < chunks.length) ctrl.enqueue(enc.encode(chunks[i++]))
      else ctrl.close()
    },
    cancel() { onCancel?.() },
  })
}

interface Call { url: string; headers: Record<string, string>; body: any }

/** 按顺序回放 responses;记录每次请求 */
function fakeFetch(responses: (() => Response)[]): { fetcher: FetchFn; calls: Call[] } {
  const calls: Call[] = []
  const fetcher: FetchFn = async (url, init) => {
    calls.push({
      url,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = responses[calls.length - 1]
    if (!next) throw new Error('意外的第 ' + calls.length + ' 次请求')
    return next()
  }
  return { fetcher, calls }
}

const sse = (chunks: string[], onCancel?: () => void) => () =>
  new Response(streamOf(chunks, onCancel), { headers: { 'content-type': 'text/event-stream' } })
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const data = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

async function drain(gen: AsyncGenerator<StreamChunk>) {
  let think = ''
  let text = ''
  let usage: any
  for await (const c of gen) {
    if (c.type === 'think') think += c.text
    else if (c.type === 'text') text += c.text
    else usage = c.usage
  }
  return { think, text, usage }
}

const env = {} as any
const msgs = [{ role: 'system' as const, content: 'S' }, { role: 'user' as const, content: 'Q' }]
describe('makeTarget / modelLabel / allowPrivate', () => {
  it('档位不在该模型可选范围里就不发;协议取模型自己的覆盖', () => {
    expect(makeTarget(provider(), 'gpt-4o', undefined, 'high').effort).toBe('')
    expect(makeTarget(provider(), 'o3', undefined, 'high')).toMatchObject({ effort: 'high', scheme: 'openai', protocol: 'openai-chat' })
    const t = makeTarget(provider(), 'claude-opus-4-7', { id: 'claude-opus-4-7', protocol: 'anthropic' }, 'xhigh')
    expect(t).toMatchObject({ protocol: 'anthropic', scheme: 'anthropic-adaptive', effort: 'xhigh' })
  })

  it('埋点名带渠道 id;私密笔记:Workers AI 照旧,外部渠道看开关', () => {
    const t = makeTarget(provider(), 'gpt-5', undefined, '')
    expect(modelLabel(t)).toBe('ext:7:gpt-5')
    expect(modelLabel({ kind: 'workers-ai', model: '@cf/x' })).toBe('@cf/x')
    expect(allowPrivate({ kind: 'workers-ai', model: '@cf/x' })).toBe(true)
    expect(allowPrivate(t)).toBe(false)
    expect(allowPrivate(makeTarget(provider({ allow_private: 1 }), 'gpt-5', undefined, ''))).toBe(true)
  })
})

describe('streamChat:外部渠道', () => {
  it('OpenAI Chat:端点、Bearer、请求体;SSE 拆成 think / text / usage', async () => {
    const { fetcher, calls } = fakeFetch([sse([
      data({ choices: [{ delta: { reasoning_content: '想' } }] }).slice(0, 20),
      data({ choices: [{ delta: { reasoning_content: '想' } }] }).slice(20) + data({ choices: [{ delta: { content: '答' } }] }),
      data({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 4 } }) + 'data: [DONE]\n\n',
    ])])
    const t = makeTarget(provider(), 'o3', undefined, 'low')
    expect(await drain(streamChat(env, t, msgs, {}, fetcher))).toEqual({ think: '想', text: '答', usage: { input: 3, output: 4 } })
    expect(calls[0].url).toBe('https://relay.test/v1/chat/completions')
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls[0].body).toMatchObject({ model: 'o3', stream: true, reasoning_effort: 'low', messages: msgs })
  })

  it('Anthropic:先 x-api-key,401 时换 Bearer 重试一次', async () => {
    const { fetcher, calls } = fakeFetch([
      json(401, { error: { message: 'invalid x-api-key' } }),
      sse([data({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'OK' } })]),
    ])
    const t = makeTarget(provider({ protocol: 'anthropic' }), 'claude-sonnet-4-5', undefined, '')
    expect((await drain(streamChat(env, t, msgs, {}, fetcher))).text).toBe('OK')
    expect(calls[0].headers['x-api-key']).toBe(KEY)
    expect(calls[0].headers.authorization).toBeUndefined()
    expect(calls[1].headers.authorization).toBe(`Bearer ${KEY}`)
    expect(calls[1].url).toBe('https://relay.test/v1/messages')
    expect(calls[1].body.system).toBe('S')
  })

  it('非 2xx 抛出上游原话,其中回显的 Key 已打码', async () => {
    const { fetcher } = fakeFetch([json(403, { error: { message: `key ${KEY} is banned` } })])
    const t = makeTarget(provider(), 'gpt-5', undefined, '')
    const e = await drain(streamChat(env, t, msgs, {}, fetcher)).catch((x) => x)
    expect(e).toBeInstanceOf(Error)
    expect(e.message).toContain('403')
    expect(e.message).toContain('banned')
    expect(e.message).not.toContain(KEY)
    expect(e.message).not.toContain(KEY.slice(4, 20))
  })

  it('连接失败的报错里也没有 Key', async () => {
    const fetcher: FetchFn = async () => { throw new Error(`connect failed for ${KEY}`) }
    const t = makeTarget(provider(), 'gpt-5', undefined, '')
    const e = await drain(streamChat(env, t, msgs, {}, fetcher)).catch((x) => x)
    expect(e.message).toContain('连接上游失败')
    expect(e.message).not.toContain(KEY)
  })

  it('上游无视 stream:true 回整段 JSON 时照样能用', async () => {
    const { fetcher } = fakeFetch([json(200, { choices: [{ message: { content: '整段', reasoning_content: 'R' } }], usage: { prompt_tokens: 1 } })])
    const t = makeTarget(provider(), 'gpt-5', undefined, '')
    expect(await drain(streamChat(env, t, msgs, {}, fetcher))).toEqual({ think: 'R', text: '整段', usage: { input: 1 } })
  })

  it('消费方提前退出(客户端断开)时 cancel 上游,免得继续计费', async () => {
    let cancelled = false
    const { fetcher } = fakeFetch([sse([
      data({ choices: [{ delta: { content: 'a' } }] }),
      data({ choices: [{ delta: { content: 'b' } }] }),
      data({ choices: [{ delta: { content: 'c' } }] }),
    ], () => { cancelled = true })])
    const t = makeTarget(provider(), 'gpt-5', undefined, '')
    for await (const c of streamChat(env, t, msgs, {}, fetcher)) {
      expect(c).toEqual({ type: 'text', text: 'a' })
      break
    }
    expect(cancelled).toBe(true)
  })
})
describe('streamChat:Workers AI', () => {
  const aiEnv = (lines: string[]) => {
    const seen: any[] = []
    return {
      seen,
      env: { AI: { run: async (model: string, input: any) => { seen.push({ model, input }); return streamOf(lines) } } } as any,
    }
  }

  it('推理模型:正文里的思考拆出来,开头漏掉的 <think> 也认(原 conversations.ts 的状态机)', async () => {
    const { env: e, seen } = aiEnv([
      'data: {"response":"先"}\n\ndata: {"response":"想</th"}\n\n',
      'data: {"response":"ink>\\n\\n答"}\n\ndata: [DONE]\n\n',
    ])
    const r = await drain(streamChat(e, { kind: 'workers-ai', model: '@cf/qwen/qwq-32b' }, msgs))
    expect(r).toEqual({ think: '先想', text: '答', usage: undefined })
    expect(seen[0].input).toMatchObject({ stream: true, max_tokens: 2048 })
  })

  it('非推理模型原样当正文,maxTokens 透传', async () => {
    const { env: e, seen } = aiEnv(['data: {"response":"<think>不是思考"}\n\n', 'data: {"response":"!"}'])
    const r = await drain(streamChat(e, { kind: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' }, msgs, { maxTokens: 300 }))
    expect(r.text).toBe('<think>不是思考!')
    expect(seen[0].input.max_tokens).toBe(300)
  })

  it('completeChat 收齐整段', async () => {
    const { env: e } = aiEnv(['data: {"response":"a"}\n\ndata: {"response":"b"}\n\n'])
    expect(await completeChat(e, { kind: 'workers-ai', model: '@cf/meta/llama-3.1-8b-instruct' }, msgs)).toEqual({ text: 'ab', think: '', usage: {} })
  })
})

describe('requestCompletion(可用性测试 / 探测)', () => {
  it('不 throw:400 带回状态码和打过码的报错', async () => {
    const { fetcher, calls } = fakeFetch([json(400, { error: { message: `reasoning_effort not supported (${KEY})` } })])
    const t = makeTarget(provider(), 'o3', undefined, 'high')
    const r = await requestCompletion(t, msgs, fetcher)
    expect(r.status).toBe(400)
    expect(r.completion).toBeNull()
    expect(r.error).toContain('not supported')
    expect(r.error).not.toContain(KEY)
    expect(calls[0].body.stream).toBe(false)
  })

  it('2xx 解析出思考证据', async () => {
    const { fetcher } = fakeFetch([json(200, { choices: [{ message: { content: '38' } }], usage: { completion_tokens_details: { reasoning_tokens: 50 } } })])
    const r = await requestCompletion(makeTarget(provider(), 'o3', undefined, 'high'), msgs, fetcher)
    expect(r.status).toBe(200)
    expect(r.completion).toMatchObject({ text: '38', reasoningSeen: true })
  })

  it('强制流式的中转站:把 SSE 拼回一个结果', async () => {
    const { fetcher } = fakeFetch([() => new Response(data({ choices: [{ delta: { reasoning_content: 'R' } }] }) + data({ choices: [{ delta: { content: 'OK' } }] }), { status: 200 })])
    const r = await requestCompletion(makeTarget(provider(), 'gpt-5', undefined, ''), msgs, fetcher)
    expect(r.completion).toMatchObject({ text: 'OK', think: 'R', reasoningSeen: true })
  })

  it('网络错误:status 0', async () => {
    const r = await requestCompletion(makeTarget(provider(), 'gpt-5', undefined, ''), msgs, async () => { throw new Error('boom') })
    expect(r.status).toBe(0)
    expect(r.error).toContain('boom')
  })
})

describe('fetchModels', () => {
  it('拉列表:/models + 鉴权头', async () => {
    const { fetcher, calls } = fakeFetch([json(200, { data: [{ id: 'a' }, { id: 'b' }] })])
    expect((await fetchModels(provider(), fetcher)).map((m) => m.id)).toEqual(['a', 'b'])
    expect(calls[0].url).toBe('https://relay.test/v1/models')
    expect(calls[0].headers.authorization).toBe(`Bearer ${KEY}`)
  })

  it('空列表、非 JSON、非 2xx 都报错,报错里没有 Key', async () => {
    await expect(fetchModels(provider(), fakeFetch([json(200, { data: [] })]).fetcher)).rejects.toThrow('空的')
    await expect(fetchModels(provider(), fakeFetch([() => new Response('<html>')]).fetcher)).rejects.toThrow('不是 JSON')
    const e = await fetchModels(provider(), fakeFetch([json(401, { message: `bad key ${KEY}` })]).fetcher).catch((x) => x)
    expect(e.message).toContain('401')
    expect(e.message).not.toContain(KEY)
  })
})
