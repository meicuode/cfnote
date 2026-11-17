// 文本生成的统一入口(P19):Workers AI 与外部渠道(中转站 / 自定义 API)都从这里走,
// 产出同一种 think / text / usage 事件。对话、/search/ai、对话测试弹窗共用。
// 嵌入不经过这里——永远是 bge-m3,向量库 1024 维,换模型就得重建索引。

import type { Env } from '../src/types'
import {
  effortOptions, parseStoredModels, parseModelList, cleanModelId, modelsUrl, endpointUrl, authHeaders,
  EFFORT_LEVELS, type AiProtocol, type Effort, type EffortScheme, type ModelEntry, type AiProviderPublic,
} from '../src/lib/aiProviders'
import {
  buildChatBody, createSseDecoder, createThinkSplitter, parseCompletion, redactKey, upstreamMessage, workersAiToken,
  type ChatMessage, type Completion, type StreamChunk, type Usage,
} from '../src/lib/aiProtocol'
import { maskSecret } from '../src/lib/notifyChannels'
import { withTimeout, isAllowedModel, isReasoningModel, DEFAULT_MODEL, getSettingValues } from './utils'

export interface ProviderRow {
  id: number
  name: string
  mode: string
  protocol: AiProtocol
  base_url: string
  api_key: string
  allow_private: number
  models?: string | null
  models_at?: string | null
  created_at?: string
  updated_at?: string
}

export type LlmTarget =
  | { kind: 'workers-ai'; model: string }
  | {
    kind: 'external'
    provider: ProviderRow
    model: string
    protocol: AiProtocol
    effort: Effort | ''
    scheme: EffortScheme
  }
export type ExternalTarget = Extract<LlmTarget, { kind: 'external' }>

/** 可注入的 fetch,单测里换成假的;默认直接调全局 fetch(解构出来再调在 workerd 里会报 Illegal invocation) */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>
const defaultFetch: FetchFn = (input, init) => fetch(input, init)

// 外部请求的超时。首包超时管「连不上 / 排队」;读超时管「流到一半不动了」,两者分开算,
// 否则一个思考很久的模型会被总超时误杀
const HEADER_TIMEOUT = 60000
const IDLE_TIMEOUT = 120000
// 可用性测试与探测是非流式的,首包就是整个答案;前端 useApi 是 90 秒,这里要比它短,错误才回得到前端
const PROBE_TIMEOUT = 80000
const MODELS_TIMEOUT = 20000
// ---- 渠道与目标 ----

const BASE_COLS = 'id, name, mode, protocol, base_url, api_key, allow_private'

export async function loadProvider(env: Env, id: number, withModels = false): Promise<ProviderRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null
  const cols = withModels ? `${BASE_COLS}, models, models_at, created_at, updated_at` : BASE_COLS
  return env.DB.prepare(`SELECT ${cols} FROM ai_providers WHERE id = ?`).bind(id).first<ProviderRow>()
}

/**
 * 只取一个模型的条目。models 列可能是几百上千个模型、带探测结果的一大段 JSON,
 * 每次对话都在 Worker 里 JSON.parse 一遍是白花 CPU(免费档 10ms),交给 SQLite 的 json_each 去找。
 */
export async function findModelEntry(env: Env, providerId: number, modelId: string): Promise<ModelEntry | undefined> {
  const row = await env.DB.prepare(
    `SELECT j.value AS v FROM ai_providers p,
       json_each(CASE WHEN json_valid(p.models) THEN p.models ELSE '[]' END) j
     WHERE p.id = ? AND json_extract(j.value, '$.id') = ? LIMIT 1`
  ).bind(providerId, modelId).first<{ v: string }>()
  if (!row?.v) return undefined
  try { return JSON.parse(row.v) as ModelEntry } catch { return undefined }
}

/**
 * 渠道 + 模型 + 档位 → 请求目标。档位不在该模型当前可选范围里的直接不发:
 * 重新检测或探测之后可选档位会变,存着的旧值发出去只会换来上游 400。
 */
export function makeTarget(provider: ProviderRow, model: string, entry: ModelEntry | undefined, effort: string): ExternalTarget {
  const protocol = entry?.protocol ?? provider.protocol
  const opts = effortOptions(entry, protocol, model)
  const e = (opts.levels as string[]).includes(effort) ? effort as Effort : ''
  return { kind: 'external', provider, model, protocol, effort: e, scheme: opts.scheme }
}

export async function targetFor(env: Env, provider: ProviderRow, model: string, effort: string): Promise<ExternalTarget> {
  return makeTarget(provider, model, await findModelEntry(env, provider.id, model), effort)
}

/**
 * 当前默认的渠道 / 模型 / 档位(settings 里的 llm_provider / llm_model / llm_effort)。
 * 选中的渠道已被删除时**报错而不是悄悄回落到 Workers AI**:回落的话用户以为在用自己选的模型,
 * 实际答案出自另一个模型,而且没有任何迹象。删渠道的接口会顺手重置设置,正常走不到这里。
 */
export async function resolveTarget(env: Env): Promise<LlmTarget> {
  const s = await getSettingValues(env, ['llm_provider', 'llm_model', 'llm_effort'])
  const providerId = s.get('llm_provider') || ''
  const model = s.get('llm_model') || ''
  if (!providerId) return { kind: 'workers-ai', model: isAllowedModel(model) ? model : DEFAULT_MODEL }
  const provider = await loadProvider(env, Number(providerId))
  if (!provider) throw new Error('当前选中的 AI 渠道已不存在,请到设置里重新选择')
  if (!model) throw new Error('当前 AI 渠道没有选模型,请到设置里选择')
  return targetFor(env, provider, model, s.get('llm_effort') || '')
}

/** 埋点里的模型名:外部渠道带上渠道 id——两个中转站的同名模型不是一回事 */
export function modelLabel(t: LlmTarget): string {
  return t.kind === 'workers-ai' ? t.model : `ext:${t.provider.id}:${t.model}`
}

/** 检索时能不能带上私密笔记:Workers AI 不出 Cloudflare,照旧;外部渠道看它自己的开关(默认关) */
export function allowPrivate(t: LlmTarget): boolean {
  return t.kind === 'workers-ai' || !!t.provider.allow_private
}

/** 一次非流式生成的总超时。外部渠道的思考模型慢得多;两者都比前端 useApi 的 90 秒短 */
export function generationTimeout(t: LlmTarget): number {
  return t.kind === 'workers-ai' ? 60000 : 85000
}
// ---- 流式生成 ----

export interface ChatOptions {
  /** 只对 Workers AI 生效。外部渠道的 max_tokens 由 buildChatBody 按协议和思考档位定 */
  maxTokens?: number
}

/**
 * 统一的流式生成。上游报错直接 throw(消息里的 Key 已打码)。
 * 消费方提前退出(客户端断开、写入失败)时,finally 里会 cancel 上游读取——外部渠道按 token 计费,
 * 不取消的话上游会把整段生成完,钱照扣。
 */
export async function* streamChat(
  env: Env, target: LlmTarget, messages: ChatMessage[], opts: ChatOptions = {}, fetcher: FetchFn = defaultFetch,
): AsyncGenerator<StreamChunk> {
  if (target.kind === 'workers-ai') yield* streamWorkersAi(env, target.model, messages, opts.maxTokens ?? 2048)
  else yield* streamExternal(target, messages, fetcher)
}

async function* streamWorkersAi(env: Env, model: string, messages: ChatMessage[], maxTokens: number): AsyncGenerator<StreamChunk> {
  const stream = await withTimeout(
    env.AI.run(model as any, { messages, max_tokens: maxTokens, stream: true }) as Promise<ReadableStream>,
    60000, 'AI 生成回答',
  )
  // Workers AI 的推理模型把思考内联在正文里,而且常漏掉开头的 <think>(implicit 模式);其余模型原样当正文
  const splitter = isReasoningModel(model) ? createThinkSplitter(true) : null
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const tok = workersAiToken(line)
        if (!tok) continue
        if (splitter) yield* splitter.push(tok)
        else yield { type: 'text', text: tok }
      }
    }
    const tok = workersAiToken(buf)
    if (tok) {
      if (splitter) yield* splitter.push(tok)
      else yield { type: 'text', text: tok }
    }
    if (splitter) yield* splitter.end()
  } finally {
    try { await reader.cancel() } catch { /* 已读完或已断开 */ }
  }
}

async function* streamExternal(
  t: ExternalTarget, messages: ChatMessage[], fetcher: FetchFn,
): AsyncGenerator<StreamChunk> {
  const key = t.provider.api_key
  try {
    const body = buildChatBody({ protocol: t.protocol, model: t.model, messages, effort: t.effort, scheme: t.scheme, stream: true })
    const res = await postJson(t, body, HEADER_TIMEOUT, fetcher)
    if (!res.ok) throw new Error(await httpError(res, key))
    if (!res.body) return
    const ctype = res.headers.get('content-type') || ''
    // 有的中转站无视 stream:true 直接回整段 JSON,有的把 SSE 标成 application/json:读完再判断
    if (!ctype.includes('text/event-stream')) {
      yield* fromWholeBody(t.protocol, await res.text())
      return
    }
    const sse = createSseDecoder(t.protocol)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await readWithTimeout(reader, IDLE_TIMEOUT)
        if (done) break
        yield* sse.push(decoder.decode(value, { stream: true }))
      }
      yield* sse.push(decoder.decode())
      yield* sse.end()
    } finally {
      try { await reader.cancel() } catch { /* 已读完或已断开 */ }
    }
  } catch (e: any) {
    throw new Error(redactKey(e?.message || String(e), key))
  }
}
/** 非 SSE 的响应体:先当一整段 JSON 结果;不是 JSON 的话再当 SSE 文本解析一遍 */
function fromWholeBody(protocol: AiProtocol, text: string): StreamChunk[] {
  let json: unknown
  try { json = JSON.parse(text) } catch { json = undefined }
  if (json === undefined) {
    const sse = createSseDecoder(protocol)
    return [...sse.push(text), ...sse.end()]
  }
  const c = parseCompletion(protocol, json)
  const out: StreamChunk[] = []
  if (c.think) out.push({ type: 'think', text: c.think })
  if (c.text) out.push({ type: 'text', text: c.text })
  if (Object.keys(c.usage).length > 0) out.push({ type: 'usage', usage: c.usage })
  return out
}

function readWithTimeout<T>(reader: ReadableStreamDefaultReader<T>, ms: number): Promise<ReadableStreamReadResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`上游 ${ms / 1000} 秒没有新数据,已中止`)), ms)
    reader.read().then(
      (r) => { clearTimeout(timer); resolve(r) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

/**
 * POST 到渠道的生成端点。Anthropic 协议先用 x-api-key,401 时换 Bearer 再试一次:
 * 有的中转站的 Claude 兼容端点只认 Bearer。401 不计费,多试一次没有代价。
 */
async function postJson(
  t: ExternalTarget, body: unknown, timeoutMs: number, fetcher: FetchFn,
): Promise<Response> {
  const url = endpointUrl(t.provider.base_url, t.protocol)
  const send = (bearer: boolean) => timedFetch(fetcher, url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(t.protocol, t.provider.api_key, bearer) },
    body: JSON.stringify(body),
  }, timeoutMs)
  return withBearerRetry(t.protocol, send)
}

async function withBearerRetry(protocol: AiProtocol, send: (bearer: boolean) => Promise<Response>): Promise<Response> {
  const res = await send(false)
  if (res.status !== 401 || protocol !== 'anthropic') return res
  try { await res.body?.cancel() } catch { /* 丢弃第一次的响应体 */ }
  return send(true)
}

/** 只管到「响应头回来」为止;响应体的读取超时在 readWithTimeout 里另算 */
async function timedFetch(fetcher: FetchFn, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetcher(url, { ...init, signal: ctrl.signal })
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error(`上游 ${ms / 1000} 秒没有响应`)
    throw new Error(`连接上游失败: ${e?.message || e}`)
  } finally {
    clearTimeout(timer)
  }
}

/** 非 2xx 的报错文本:优先取 JSON 里的 message,否则截一段原文(可能是 HTML 拦截页)。Key 已打码 */
async function httpError(res: Response, key: string): Promise<string> {
  let text = ''
  try { text = await res.text() } catch { /* 读不到响应体 */ }
  let msg = ''
  try { msg = upstreamMessage(JSON.parse(text)) } catch { /* 不是 JSON */ }
  if (!msg) msg = clip(text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), 300)
  return redactKey(`上游返回 ${res.status}${msg ? `: ${msg}` : ''}`, key)
}

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
export interface ChatResult { text: string; think: string; usage: Usage }

function collect(chunks: Iterable<StreamChunk>, into: ChatResult): ChatResult {
  for (const c of chunks) {
    if (c.type === 'text') into.text += c.text
    else if (c.type === 'think') into.think += c.text
    else into.usage = c.usage
  }
  return into
}

/** 收齐一次生成(非流式对话、联网搜索总结、/search/ai)。总超时由调用方按 generationTimeout 包 */
export async function completeChat(
  env: Env, target: LlmTarget, messages: ChatMessage[], opts: ChatOptions = {}, fetcher: FetchFn = defaultFetch,
): Promise<ChatResult> {
  const r: ChatResult = { text: '', think: '', usage: {} }
  for await (const c of streamChat(env, target, messages, opts, fetcher)) collect([c], r)
  return r
}

// ---- 可用性测试 / 思考探测 / 模型检测 ----

export interface ProbeCall { status: number; ms: number; completion: Completion | null; error?: string }

/**
 * 非流式请求一次:要完整的 usage 和 thinking 块才判得准,流里拼不全(Anthropic 省略思考时只剩签名)。
 * 不 throw:失败也要带回状态码和耗时,探测靠状态码区分「拒绝」和「出错」。
 */
export async function requestCompletion(
  t: ExternalTarget, messages: ChatMessage[], fetcher: FetchFn = defaultFetch,
): Promise<ProbeCall> {
  const key = t.provider.api_key
  const started = Date.now()
  try {
    const body = buildChatBody({ protocol: t.protocol, model: t.model, messages, effort: t.effort, scheme: t.scheme, stream: false, brief: true })
    const res = await postJson(t, body, PROBE_TIMEOUT, fetcher)
    if (!res.ok) return { status: res.status, ms: Date.now() - started, completion: null, error: await httpError(res, key) }
    const text = await res.text()
    const ms = Date.now() - started
    let json: unknown
    try { json = JSON.parse(text) } catch { json = undefined }
    if (json !== undefined) return { status: res.status, ms, completion: parseCompletion(t.protocol, json) }
    // 有的中转站强制流式:把 SSE 拼回一个结果
    if (/^\s*(data|event):/m.test(text)) {
      const r = collect(fromWholeBody(t.protocol, text), { text: '', think: '', usage: {} })
      const completion: Completion = { ...r, text: r.text.trim(), think: r.think.trim(), reasoningSeen: !!r.think.trim() || (r.usage.reasoning ?? 0) > 0 }
      return { status: res.status, ms, completion }
    }
    return { status: res.status, ms, completion: null, error: redactKey(`上游返回的不是 JSON: ${clip(text, 200)}`, key) }
  } catch (e: any) {
    return { status: 0, ms: Date.now() - started, completion: null, error: redactKey(e?.message || String(e), key) }
  }
}

/**
 * 拉模型列表(检测)。列表为空也算失败:合并时空列表会删掉全部非手动模型,
 * 而这种情况多半是上游出了问题,不是真的一个模型都没有。
 */
export async function fetchModels(p: ProviderRow, fetcher: FetchFn = defaultFetch): Promise<ModelEntry[]> {
  try {
    const url = modelsUrl(p.base_url, p.protocol)
    const res = await withBearerRetry(p.protocol, (bearer) =>
      timedFetch(fetcher, url, { headers: authHeaders(p.protocol, p.api_key, bearer) }, MODELS_TIMEOUT))
    if (!res.ok) throw new Error(await httpError(res, p.api_key))
    let json: unknown
    try { json = await res.json() } catch { throw new Error('模型列表不是 JSON,Base URL 可能填错了') }
    const list = parseModelList(json)
    if (list.length === 0) throw new Error('上游返回的模型列表是空的')
    return list
  } catch (e: any) {
    throw new Error(redactKey(e?.message || String(e), p.api_key))
  }
}
// ---- SSE 响应 ----

export type SseSend = (obj: unknown) => Promise<void>

/**
 * 返回一个 SSE 响应,produce 在 waitUntil 里跑。produce 抛错会变成 error 事件。
 * 客户端断开后 send 会 reject,错误一路冒到 produce 里正在 for-await 的 streamChat,
 * 它的 finally 就会 cancel 上游。
 */
export function sseResponse(ctx: { waitUntil(p: Promise<unknown>): void }, produce: (send: SseSend) => Promise<void>): Response {
  const encoder = new TextEncoder()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const send: SseSend = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`))
  ctx.waitUntil((async () => {
    try {
      await produce(send)
    } catch (e: any) {
      try { await send({ type: 'error', message: e?.message || String(e) }) } catch { /* 客户端可能已断开 */ }
    } finally {
      try { await writer.close() } catch { /* 已关闭 */ }
    }
  })())
  return new Response(readable, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' },
  })
}

// ---- 设置校验与下发 ----

/**
 * PUT /api/settings 里 llm_provider / llm_model / llm_effort 三项联合校验;没出现在请求体里的取库里的旧值。
 * - 换渠道必须同时给 llm_model:否则旧渠道的模型 ID 会被拿去请求新渠道
 * - Workers AI 的模型仍走白名单;外部渠道的模型 ID 只做格式校验(中转站有什么模型我们不知道)
 * - 档位只校验是不是已知值;该模型支不支持在请求时由 makeTarget 过滤
 */
export async function validateLlmSettings(env: Env, body: Record<string, unknown>): Promise<string | null> {
  const has = (k: string) => body[k] !== undefined
  if (!has('llm_provider') && !has('llm_model') && !has('llm_effort')) return null
  for (const k of ['llm_provider', 'llm_model', 'llm_effort']) {
    if (has(k) && typeof body[k] !== 'string') return `${k} 必须是字符串`
  }
  const stored = await getSettingValues(env, ['llm_provider', 'llm_model'])
  const storedProvider = stored.get('llm_provider') || ''
  const provider = has('llm_provider') ? String(body.llm_provider) : storedProvider
  const model = has('llm_model') ? String(body.llm_model) : (stored.get('llm_model') || '')
  if (has('llm_effort') && body.llm_effort !== '' && !(EFFORT_LEVELS as readonly string[]).includes(String(body.llm_effort))) {
    return '不支持的思考强度'
  }
  if (provider !== storedProvider && !has('llm_model')) return '切换渠道时需要同时选择模型'
  if (!provider) {
    if (has('llm_model') && !isAllowedModel(model)) return '不支持的模型'
    if (!has('llm_model') && model && !isAllowedModel(model)) return '当前模型不属于 Workers AI,请重新选择模型'
    return null
  }
  if (!(await loadProvider(env, Number(provider)))) return 'AI 渠道不存在'
  if (!cleanModelId(model)) return '请选择模型'
  return null
}

/** 下发给前端的形态:Key 只露后四位 */
export function toPublic(p: ProviderRow): AiProviderPublic {
  return {
    id: p.id,
    name: p.name,
    mode: p.mode === 'custom' ? 'custom' : 'relay',
    protocol: p.protocol,
    base_url: p.base_url,
    api_key: maskSecret(p.api_key),
    allow_private: !!p.allow_private,
    models: parseStoredModels(p.models),
    models_at: p.models_at ?? null,
    created_at: p.created_at ?? '',
    updated_at: p.updated_at ?? '',
  }
}
