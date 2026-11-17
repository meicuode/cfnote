// 外部 AI 渠道(P19):中转站 / 自定义 API 的配置层——Base URL 规整、/models 解析、
// 思考强度规则表、表单校验。纯函数,前端表单与 worker 共用,便于单测。
// 请求体构造与 SSE 解析这类「线上格式」在 aiProtocol.ts;真正发请求在 worker/llm.ts。

/** 三种上游协议。Gemini / DeepSeek / 通义等走它们的 OpenAI 兼容端点,不做原生协议 */
export type AiProtocol = 'openai-chat' | 'openai-responses' | 'anthropic'
export const AI_PROTOCOLS: AiProtocol[] = ['openai-chat', 'openai-responses', 'anthropic']
export const PROTOCOL_LABEL: Record<AiProtocol, string> = {
  'openai-chat': 'OpenAI Chat Completions',
  'openai-responses': 'OpenAI Responses',
  anthropic: 'Anthropic Messages',
}

/** relay = 中转站(保存后自动拉模型列表);custom = 自定义(模型可以手动加,拉列表失败也能用) */
export type AiMode = 'relay' | 'custom'

/** 思考强度的全集。每个协议、每个模型只支持其中一部分 */
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type Effort = typeof EFFORT_LEVELS[number]
export const EFFORT_LABEL: Record<Effort, string> = {
  none: '不思考', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高',
}

/**
 * 思考参数怎么发:
 * - openai:Chat 的 `reasoning_effort` / Responses 的 `reasoning.effort`
 * - anthropic-adaptive:Claude 4.6 及以后,`thinking:{type:'adaptive'}` + `output_config.effort`
 * - anthropic-budget:Claude 3.7 ~ 4.5,`thinking:{type:'enabled', budget_tokens}`,档位换算成 token 数
 * - always:常开推理(deepseek-reasoner、qwq 等),没有可选档位,只解析思考输出
 * - none:不发任何思考参数
 */
export type EffortScheme = 'openai' | 'anthropic-adaptive' | 'anthropic-budget' | 'always' | 'none'

/** 探测结果:rejected = 上游 400;accepted = 没报错但看不到思考;effective = 确实有思考;error = 与参数无关的失败 */
export type ProbeOutcome = 'rejected' | 'accepted' | 'effective' | 'error'
export interface ProbeResult { outcome: ProbeOutcome; detail?: string; reasoning_tokens?: number }

export interface ModelEntry {
  id: string
  starred?: boolean
  /** 手动添加的(重新检测时不会因为上游列表里没有而被删掉) */
  manual?: boolean
  /** 单个模型的协议覆盖:同一个中转站上 gpt 走 Chat、claude 走 Messages 很常见 */
  protocol?: AiProtocol
  /** /models 里附带的能力字段(OpenRouter 等才有) */
  meta?: { efforts?: Effort[]; reasoning?: boolean; endpoints?: string[] }
  /** 思考强度探测结果。scheme 记下探测时用的发参方式,协议改了之后旧结果自动作废 */
  probe?: { at: string; scheme: EffortScheme; results: Partial<Record<Effort, ProbeResult>> }
}

/** 渠道的公开形态(GET 下发给前端的样子,api_key 已掩码) */
export interface AiProviderPublic {
  id: number
  name: string
  mode: AiMode
  protocol: AiProtocol
  base_url: string
  api_key: string
  allow_private: boolean
  models: ModelEntry[]
  models_at: string | null
  created_at: string
  updated_at: string
}
// ---- Base URL ----

// 用户常把完整端点粘进来(…/v1/chat/completions),规整时剥掉。长的在前,免得 /completions 先命中
const ENDPOINT_SUFFIXES = ['/chat/completions', '/completions', '/responses', '/messages', '/models']

/**
 * 规整 Base URL;不合法返回 null。
 * - 只认 http/https:base_url 会被 worker 拿去 fetch,别的 scheme 没有正当用途
 * - 拒绝 user:pass@ 形式:凭据写进 URL 会原样出现在列表、日志和报错里,Key 应该填 Key 栏
 * - 去掉查询串与末尾斜杠;裸域名补 /v1(几乎所有中转站和官方端点都在 /v1 下)
 */
export function normalizeBaseUrl(input: string): string | null {
  const raw = (input || '').trim()
  if (!raw) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (u.username || u.password) return null
  let path = u.pathname.replace(/\/+$/, '')
  for (const s of ENDPOINT_SUFFIXES) {
    if (path.toLowerCase().endsWith(s)) { path = path.slice(0, -s.length).replace(/\/+$/, ''); break }
  }
  if (!path) path = '/v1'
  return u.origin + path
}

const ENDPOINT_PATH: Record<AiProtocol, string> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  anthropic: '/messages',
}

/** 实际请求地址(表单里实时显示,用户一眼能看出 /v1 有没有重复) */
export function endpointUrl(baseUrl: string, protocol: AiProtocol): string {
  return baseUrl.replace(/\/+$/, '') + ENDPOINT_PATH[protocol]
}

/** Anthropic 的 /models 默认一页 20 个,最大 1000;带上 limit 省掉翻页。中转站多半忽略这个参数,无害 */
export function modelsUrl(baseUrl: string, protocol: AiProtocol): string {
  const base = baseUrl.replace(/\/+$/, '') + '/models'
  return protocol === 'anthropic' ? base + '?limit=1000' : base
}

/**
 * 鉴权头。Anthropic 官方是 x-api-key + anthropic-version;OpenAI 兼容是 Bearer。
 * 有的中转站的 Claude 兼容端点只认 Bearer,worker 在 401 时会换 Bearer 重试一次(见 llm.ts)。
 */
export function authHeaders(protocol: AiProtocol, apiKey: string, bearer = false): Record<string, string> {
  if (protocol === 'anthropic' && !bearer) {
    return { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
  }
  const h: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  if (protocol === 'anthropic') h['anthropic-version'] = '2023-06-01'
  return h
}
// ---- 模型列表 ----

export const MAX_MODELS = 2000
export const MAX_MODEL_ID = 200

/** 模型 ID 校验:去首尾空白,拒绝空串、超长、控制字符。中转站的 ID 可能带空格和方括号前缀,这些放行 */
export function cleanModelId(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!s || s.length > MAX_MODEL_ID || /[\u0000-\u001f\u007f]/.test(s)) return null
  return s
}

/**
 * 解析 /models 的返回。见过的形状:
 * - OpenAI / Anthropic / 大多数中转站:`{ data: [{ id }] }`
 * - 少数中转站直接回数组,元素是对象或字符串
 * - Gemini 等:`{ models: [{ name: 'models/xxx' }] }`
 * 能力字段只认三种:OpenRouter 的 supported_parameters、reasoning_options.effort.values、
 * new-api 的 supported_endpoint_types。认不出就不填 meta,交给规则表和探测。
 */
export function parseModelList(json: unknown): ModelEntry[] {
  const j: any = json
  const arr: unknown[] = Array.isArray(j) ? j
    : Array.isArray(j?.data) ? j.data
    : Array.isArray(j?.models) ? j.models
    : []
  const out: ModelEntry[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    const it: any = item
    const rawId = typeof it === 'string' ? it : it?.id ?? it?.name
    let id = cleanModelId(rawId)
    if (!id) continue
    if (typeof it === 'object' && !it.id && id.startsWith('models/')) id = id.slice('models/'.length)
    if (seen.has(id)) continue
    seen.add(id)
    const entry: ModelEntry = { id }
    const meta = typeof it === 'object' && it ? extractMeta(it) : undefined
    if (meta) entry.meta = meta
    out.push(entry)
    if (out.length >= MAX_MODELS) break
  }
  return out
}

function extractMeta(it: any): ModelEntry['meta'] | undefined {
  const meta: NonNullable<ModelEntry['meta']> = {}
  const params = it.supported_parameters
  if (Array.isArray(params) && params.some((p: unknown) => p === 'reasoning' || p === 'reasoning_effort' || p === 'include_reasoning')) {
    meta.reasoning = true
  }
  const values = it.reasoning_options?.effort?.values ?? it.reasoning?.efforts
  if (Array.isArray(values)) {
    const efforts = values.filter((v: unknown): v is Effort => typeof v === 'string' && (EFFORT_LEVELS as readonly string[]).includes(v))
    if (efforts.length > 0) { meta.efforts = efforts; meta.reasoning = true }
  }
  const eps = it.supported_endpoint_types
  if (Array.isArray(eps)) {
    const endpoints = eps.filter((v: unknown): v is string => typeof v === 'string').slice(0, 10)
    if (endpoints.length > 0) meta.endpoints = endpoints
  }
  return Object.keys(meta).length > 0 ? meta : undefined
}

/**
 * 重新检测后合并:上游列表为准,但保留用户在本地做的事——标星、协议覆盖、探测结果。
 * 手动加的模型即使上游没列出来也留着(很多中转站的 /models 不全)。上游没了的非手动模型丢掉。
 */
export function mergeDetected(prev: ModelEntry[], detected: ModelEntry[]): ModelEntry[] {
  const old = new Map(prev.map((m) => [m.id, m]))
  const out: ModelEntry[] = detected.map((d) => {
    const o = old.get(d.id)
    if (!o) return d
    const m: ModelEntry = { ...d }
    if (o.starred) m.starred = true
    if (o.protocol) m.protocol = o.protocol
    if (o.probe) m.probe = o.probe
    return m
  })
  const have = new Set(out.map((m) => m.id))
  for (const o of prev) if (o.manual && !have.has(o.id)) out.push(o)
  return out
}

/** 读 models 列(JSON 文本);坏数据当空列表,别让一条坏行把整个渠道弄挂 */
export function parseStoredModels(raw: string | null | undefined): ModelEntry[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((m) => m && typeof m.id === 'string') : []
  } catch {
    return []
  }
}
// ---- 思考强度规则表 ----
//
// /models 不会告诉你一个模型支持哪些思考档位,只能按模型名猜。这张表**一定会过时**:
// 它只是探测之前的默认值,探测结果优先(effortOptions)。只收录文档写明了的系列,
// 认不出的一律 none——宁可不发参数,也不要发一个让上游 400 的参数。

export interface EffortRule { scheme: EffortScheme; levels: Effort[] }
const NONE: EffortRule = { scheme: 'none', levels: [] }
const ALWAYS: EffortRule = { scheme: 'always', levels: [] }
const LMH: Effort[] = ['low', 'medium', 'high']

/** 去掉中转站常加的前缀:「[渠道] 」、「anthropic/」、「us.anthropic.」。只用于匹配规则,发给上游的仍是原 ID */
function bareId(id: string): string {
  return id.toLowerCase().replace(/^\[[^\]]*\]\s*/, '').replace(/^.*\//, '')
}

/**
 * 从 Claude 的模型名里读版本号:claude-opus-4-5-20251101 → [4,5];claude-sonnet-4-20250514 → [4,0];
 * claude-3-7-sonnet → [3,7];claude-opus-5-5 → [5,5]。8 位日期不是版本号,`\d{1,2}(?!\d)` 把它挡在外面。
 */
export function claudeVersion(id: string): [number, number] | null {
  const s = bareId(id)
  const m = s.match(/claude-(?:[a-z]+-)?(\d{1,2})(?:[-.](\d{1,2})(?!\d))?/)
  if (!m) return null
  return [Number(m[1]), m[2] ? Number(m[2]) : 0]
}

function atLeast(v: [number, number], major: number, minor: number): boolean {
  return v[0] > major || (v[0] === major && v[1] >= minor)
}

export function effortRule(modelId: string, protocol: AiProtocol): EffortRule {
  const s = bareId(modelId)
  const cv = claudeVersion(modelId)

  if (protocol === 'anthropic') {
    if (!cv) return NONE
    // 4.7 起多了 xhigh;4.6 只有 low/medium/high/max。4.6 起 budget_tokens 已弃用,Opus 4.7 起直接 400
    if (atLeast(cv, 4, 7)) return { scheme: 'anthropic-adaptive', levels: ['low', 'medium', 'high', 'xhigh', 'max'] }
    if (atLeast(cv, 4, 6)) return { scheme: 'anthropic-adaptive', levels: ['low', 'medium', 'high', 'max'] }
    if (atLeast(cv, 3, 7)) return { scheme: 'anthropic-budget', levels: LMH }
    return NONE
  }

  // 以下是 OpenAI 兼容协议(Chat / Responses 发参方式相同,都是 effort 字符串)
  // 名字里带 thinking / reasoner 的是常开推理的变体(中转站常把 claude-xxx-thinking 单独列一个 ID)
  if (/(^|[-_])(thinking|reasoner)([-_]|$)/.test(s) || /(^|[-_])r1([-_]|$)/.test(s) || s.startsWith('qwq')) return ALWAYS
  // 走 OpenAI 协议的 Claude:中转站会不会把 reasoning_effort 翻译成 thinking 说不准,不猜,交给探测
  if (cv) return NONE
  if (/^o1-(mini|preview)/.test(s)) return ALWAYS
  if (/^o[134](-|$)/.test(s)) return { scheme: 'openai', levels: LMH }
  const g5 = s.match(/^gpt-5(?:\.(\d+))?(-[a-z]+)?/)
  if (g5) {
    const minor = g5[1] ? Number(g5[1]) : 0
    const variant = g5[2] || ''
    if (variant === '-chat') return NONE
    if (variant === '-pro') return NONE
    if (variant === '-codex') return { scheme: 'openai', levels: minor >= 2 ? [...LMH, 'xhigh'] : LMH }
    if (minor === 0) return { scheme: 'openai', levels: ['minimal', ...LMH] }
    if (minor === 1) return { scheme: 'openai', levels: ['none', ...LMH] }
    return { scheme: 'openai', levels: ['none', ...LMH, 'xhigh'] }
  }
  if (/^gemini-(2\.5|3)/.test(s)) return { scheme: 'openai', levels: LMH }
  return NONE
}
/** 探测前要试哪些档位、用什么方式发参。规则表认得的按它来;认不出的按协议给一组通用档位去试 */
export function probeCandidates(modelId: string, protocol: AiProtocol): EffortRule {
  const r = effortRule(modelId, protocol)
  if (r.scheme !== 'none') return r
  return protocol === 'anthropic'
    ? { scheme: 'anthropic-adaptive', levels: LMH }
    : { scheme: 'openai', levels: LMH }
}

function schemeFits(scheme: EffortScheme, protocol: AiProtocol): boolean {
  const anthropic = scheme === 'anthropic-adaptive' || scheme === 'anthropic-budget'
  return protocol === 'anthropic' ? anthropic : scheme === 'openai'
}

/**
 * 选择器里能选的档位,以及请求时怎么发参。优先级:探测结果 > /models 能力字段 > 规则表。
 * - 探测里 accepted 也算可选:上游没报错,只是这道题它不想多想,不代表参数没用
 * - 探测全是 error(网络、限流)不算数,回落到规则表,别让一次抖动把档位全藏起来
 * - 探测时的发参方式和当前协议对不上(协议改过)的,作废
 */
export function effortOptions(entry: ModelEntry | undefined, protocol: AiProtocol, modelId = entry?.id ?? ''): EffortRule {
  const rule = effortRule(modelId, protocol)
  const p = entry?.probe
  if (p && schemeFits(p.scheme, protocol)) {
    const all = Object.entries(p.results) as [Effort, ProbeResult][]
    if (all.some(([, r]) => r.outcome !== 'error')) {
      const levels = EFFORT_LEVELS.filter((l) => {
        const r = p.results[l]
        return r && (r.outcome === 'accepted' || r.outcome === 'effective')
      })
      return { scheme: p.scheme, levels }
    }
  }
  const metaEfforts = entry?.meta?.efforts
  if (metaEfforts && metaEfforts.length > 0 && protocol !== 'anthropic') {
    return { scheme: 'openai', levels: EFFORT_LEVELS.filter((l) => metaEfforts.includes(l)) }
  }
  return rule
}

// ---- 表单校验 ----

export interface ProviderInput {
  name?: string
  mode?: AiMode
  protocol?: AiProtocol
  base_url?: string
  api_key?: string
  allow_private?: boolean
}

/**
 * 校验渠道表单。partial=true 用于更新:没给的字段不动;api_key 为空串或仍是掩码值视为「不改」。
 * 新建时 Key 必填——没有 Key 的渠道什么都做不了,早报错比检测时报 401 好懂。
 */
export function validateProviderInput(
  body: unknown, partial: boolean, maskPrefix: string,
): { ok: true; value: ProviderInput } | { ok: false; error: string } {
  const b: any = body && typeof body === 'object' ? body : {}
  const v: ProviderInput = {}
  if (b.name !== undefined || !partial) {
    const name = typeof b.name === 'string' ? b.name.trim() : ''
    if (!name) return { ok: false, error: '名称不能为空' }
    if (name.length > 50) return { ok: false, error: '名称最多 50 个字' }
    v.name = name
  }
  if (b.mode !== undefined || !partial) {
    const mode = b.mode ?? 'relay'
    if (mode !== 'relay' && mode !== 'custom') return { ok: false, error: '添加方式只能是中转站或自定义' }
    v.mode = mode
  }
  if (b.protocol !== undefined || !partial) {
    const protocol = b.protocol ?? 'openai-chat'
    if (!AI_PROTOCOLS.includes(protocol)) return { ok: false, error: '不支持的协议' }
    v.protocol = protocol
  }
  if (b.base_url !== undefined || !partial) {
    const url = normalizeBaseUrl(typeof b.base_url === 'string' ? b.base_url : '')
    if (!url) return { ok: false, error: 'Base URL 需要是 http(s) 地址,且不能带用户名密码' }
    v.base_url = url
  }
  const key = typeof b.api_key === 'string' ? b.api_key.trim() : ''
  if (key && !key.startsWith(maskPrefix)) {
    if (key.length > 500 || /[\s\u0000-\u001f]/.test(key)) return { ok: false, error: 'API Key 格式不对(不能含空白或控制字符)' }
    v.api_key = key
  } else if (!partial) {
    return { ok: false, error: 'API Key 不能为空' }
  }
  if (b.allow_private !== undefined) v.allow_private = b.allow_private === true
  else if (!partial) v.allow_private = false
  return { ok: true, value: v }
}
