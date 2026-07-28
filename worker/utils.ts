import type { Env } from '../src/types'

// ---- Allowed LLM Models ----

export interface AllowedModel {
  id: string
  label: string
  description: string
  type: '通用' | '推理'
  cost: string
  isReasoning: boolean
}

export const ALLOWED_MODELS: AllowedModel[] = [
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', description: '轻量快速，适合简单问答', type: '通用', cost: '~15 neurons', isReasoning: false },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', description: '大模型，综合能力强', type: '通用', cost: '~88 neurons', isReasoning: false },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 32B', description: '推理能力强，适合复杂分析', type: '推理', cost: '~178 neurons', isReasoning: true },
  { id: '@cf/qwen/qwq-32b', label: 'QwQ 32B', description: '推理型，中文表现优秀', type: '推理', cost: '~87 neurons', isReasoning: true },
]

export const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

export function isAllowedModel(modelId: string): boolean {
  return ALLOWED_MODELS.some(m => m.id === modelId)
}

export async function getSettingValue(env: Env, key: string, defaultValue: string): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?'
  ).bind(key).first<{ value: string }>()
  return row?.value ?? defaultValue
}

/** 一次取多个设置项:公开博客接口一个页面要读好几个键,分开查就是好几趟 D1 往返 */
export async function getSettingValues(env: Env, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (keys.length === 0) return out
  const holes = keys.map(() => '?').join(',')
  const { results } = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN (${holes})`
  ).bind(...keys).all<{ key: string; value: string }>()
  for (const r of results || []) out.set(r.key, r.value)
  return out
}

export async function getApiKey(env: Env, keyName: string): Promise<string | undefined> {
  const fromSettings = await getSettingValue(env, keyName, '')
  return fromSettings || (env as any)[keyName.toUpperCase()] || undefined
}

export function stripThinkTags(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '')
  // QwQ 等推理模型常漏掉开头的 <think>,只输出结尾的 </think>:丢弃闭合标签之前的全部内容
  const close = t.lastIndexOf('</think>')
  if (close >= 0 && !t.includes('<think>')) t = t.slice(close + '</think>'.length)
  return t.trim()
}

// 规范化思考标签:保留思考内容供前端折叠展示,只修复缺失的开头 <think>
export function normalizeThinkTags(text: string): string {
  if (text.includes('</think>') && !text.includes('<think>')) return '<think>' + text
  return text
}

export function isReasoningModel(modelId: string): boolean {
  return ALLOWED_MODELS.find(m => m.id === modelId)?.isReasoning ?? false
}

// ---- System Logging ----

// ---- Analytics Engine ----

export const AE_DATASET = 'cfnote_usage'

export function trackEvent(env: Env, action: string, userId: number, model?: string) {
  try {
    if (env.ANALYTICS) {
      env.ANALYTICS.writeDataPoint({
        blobs: [action, model ?? '', userId.toString()],
        doubles: [1],
        indexes: [action],
      })
    }
  } catch { /* AE not available locally */ }
}

/** Query the AE SQL API. Throws on HTTP error so callers can distinguish failure from empty. */
export async function queryAeSql<T>(token: string, accountId: string, sql: string): Promise<T[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` }, body: sql },
  )
  if (!res.ok) throw new Error(`AE SQL 查询失败: ${res.status} ${await res.text()}`)
  const json = await res.json() as any
  return (json.data ?? []) as T[]
}

export function logSystem(
  env: Env, level: 'error' | 'warn' | 'info',
  source: string, message: string, detail?: unknown,
) {
  env.DB.prepare(
    'INSERT INTO system_logs (level, source, message, detail) VALUES (?, ?, ?, ?)'
  ).bind(level, source, message, detail ? JSON.stringify(detail) : null)
    .run().catch(() => {})
}

// ---- Jina API (shared) ----

async function jinaHeaders(env: Env, extra?: Record<string, string>): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Accept': 'application/json', ...extra }
  const key = await getApiKey(env, 'jina_api_key')
  if (key) headers['Authorization'] = `Bearer ${key}`
  return headers
}

export interface JinaReadResult {
  title: string
  content: string
}

/** Fetch & parse a web page via Jina Reader (r.jina.ai). Returns title + markdown content. */
export async function jinaReadUrl(env: Env, url: string): Promise<JinaReadResult> {
  const headers = await jinaHeaders(env, { 'X-Return-Format': 'markdown' })
  const res = await fetch(`https://r.jina.ai/${url.trim()}`, { headers })
  if (!res.ok) throw new Error(`Jina Reader 请求失败 (HTTP ${res.status})`)

  const contentType = res.headers.get('Content-Type') || ''
  if (contentType.includes('application/json')) {
    const json = await res.json() as any
    return {
      title: json.data?.title || json.title || new URL(url).hostname,
      content: json.data?.content || json.content || '',
    }
  }

  // Non-JSON fallback (plain text / markdown)
  const text = await res.text()
  if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
    throw new Error('Jina Reader 无法抓取该页面（目标网站可能阻止了抓取）')
  }
  const headingMatch = text.match(/^#\s+(.+)$/m)
  return {
    title: headingMatch?.[1]?.trim() || new URL(url).hostname,
    content: text,
  }
}

export interface WebSearchResult {
  title: string
  url: string
  content: string
}

/** Search the web via Jina Search (s.jina.ai). Returns top 5 results. */
export async function jinaSearch(env: Env, query: string): Promise<WebSearchResult[]> {
  const headers = await jinaHeaders(env)
  const res = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, { headers })
  if (!res.ok) throw new Error(`Jina Search 请求失败 (HTTP ${res.status})`)

  const json = await res.json() as any
  const items = json.data ?? json.results ?? []
  return items.slice(0, 5).map((item: any) => ({
    title: item.title || '',
    url: item.url || '',
    content: (item.content || item.description || '').slice(0, 1000),
  }))
}



// ---- Timeout Helper ----

export function withTimeout<T>(promise: Promise<T>, ms: number, label = 'operation'): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}

// ---- Password Hashing (PBKDF2-SHA256) ----

export async function hashPassword(password: string, salt: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  )
  return bufToHex(new Uint8Array(bits))
}

export function generateSalt(): string {
  const buf = new Uint8Array(16)
  crypto.getRandomValues(buf)
  return bufToHex(buf)
}

// ---- JWT (HMAC-SHA256) ----

export async function createJWT(payload: Record<string, unknown>, secret: string): Promise<string> {
  if (!secret) throw new Error('JWT_SECRET 未配置，请在 Worker 的 Settings → Variables and Secrets 中添加（类型选 Secret）')
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const fullPayload = { ...payload, iat: now, exp: now + 7 * 24 * 3600 }
  const segments = [b64url(JSON.stringify(header)), b64url(JSON.stringify(fullPayload))]
  const data = segments.join('.')
  const key = await getHmacKey(secret)
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  segments.push(b64url(sig))
  return segments.join('.')
}

export async function verifyJWT(token: string, secret: string): Promise<Record<string, unknown> | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const key = await getHmacKey(secret)
    const data = `${parts[0]}.${parts[1]}`
    const sig = b64urlDecode(parts[2])
    const valid = await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(data))
    if (!valid) return null
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null
    return payload
  } catch {
    return null
  }
}

async function getHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

// ---- Text Chunking ----

const CHUNK_SIZE = 500
const CHUNK_OVERLAP = 100

export function chunkText(text: string): string[] {
  const cleaned = text.trim()
  if (cleaned.length <= CHUNK_SIZE) return [cleaned]
  const chunks: string[] = []
  const step = CHUNK_SIZE - CHUNK_OVERLAP
  for (let i = 0; i < cleaned.length; i += step) {
    chunks.push(cleaned.slice(i, i + CHUNK_SIZE))
    if (i + CHUNK_SIZE >= cleaned.length) break
  }
  return chunks
}

// ---- Content Hash ----

export async function contentHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return bufToHex(new Uint8Array(buf))
}

// ---- Helpers ----

export function json<T>(data: T, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function err(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status)
}

export function ok<T>(data?: T): Response {
  return json({ ok: true, data })
}

function bufToHex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function b64url(input: string | ArrayBuffer): string {
  const str = typeof input === 'string' ? btoa(input) : btoa(String.fromCharCode(...new Uint8Array(input)))
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(input: string): ArrayBuffer {
  const str = atob(input.replace(/-/g, '+').replace(/_/g, '/'))
  const buf = new Uint8Array(str.length)
  for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i)
  return buf.buffer
}

// ---- RAG Search ----

export interface RagSource {
  article_id: number
  article_title: string
  notebook_name: string
  chunk_text: string
  score: number
}

export async function ragSearch(
  env: Env, query: string, userId: number, topK = 5
): Promise<{ contextParts: string[], sources: RagSource[] }> {
  const empty = { contextParts: [] as string[], sources: [] as RagSource[] }

  try {
    // 1. Embed the query
    const embedResult: any = await withTimeout(
      env.AI.run('@cf/baai/bge-m3' as any, { text: [query.trim()] }),
      15000, 'AI embedding',
    )
    const queryVector = embedResult?.data?.[0] as number[] | undefined

    if (!queryVector || queryVector.length === 0) return empty

    // 2. Search Vectorize — try with filter, fallback to no filter
    const filter: Record<string, number> = { user_id: userId }

    let matches = await env.VECTORIZE.query(queryVector, {
      topK: 10,
      filter,
      returnMetadata: 'all',
    })

    let usedFallback = false
    if (!matches.matches || matches.matches.length === 0) {
      matches = await env.VECTORIZE.query(queryVector, {
        topK: 10,
        returnMetadata: 'all',
      })
      usedFallback = true
    }

    if (!matches.matches || matches.matches.length === 0) return empty

    // 3. Fetch chunk texts for context
    const sources: RagSource[] = []
    const contextParts: string[] = []

    for (const match of matches.matches) {
      const articleId = match.metadata?.article_id as number
      const chunkIndex = match.metadata?.chunk_index as number
      if (!articleId && articleId !== 0) continue

      const article = await env.DB.prepare(
        `SELECT a.id, a.title, a.notebook_id, a.user_id, n.name as notebook_name
         FROM articles a LEFT JOIN notebooks n ON a.notebook_id = n.id
         WHERE a.id = ? AND a.deleted_at IS NULL`
      ).bind(articleId).first<any>()

      const chunk = await env.DB.prepare(
        'SELECT chunk_text FROM chunks WHERE article_id = ? AND chunk_index = ?'
      ).bind(articleId, chunkIndex).first<{ chunk_text: string }>()

      if (article && chunk) {
        if (usedFallback && article.user_id !== userId) continue

        contextParts.push(`[${sources.length + 1}] ${chunk.chunk_text}`)
        sources.push({
          article_id: article.id,
          article_title: article.title,
          notebook_name: article.notebook_name || '',
          chunk_text: chunk.chunk_text,
          score: match.score,
        })
      }

      if (sources.length >= topK) break
    }

    return { contextParts, sources }
  } catch (e) {
    console.error('ragSearch failed:', e)
    return empty
  }
}

// ---- Auth Middleware Helper ----

export async function getUser(request: Request, env: Env): Promise<{ id: number; username: string } | null> {
  const auth = request.headers.get('Authorization')
  if (!auth?.startsWith('Bearer ')) return null
  const payload = await verifyJWT(auth.slice(7), env.JWT_SECRET)
  if (!payload || !payload.uid) return null
  return { id: payload.uid as number, username: payload.username as string }
}

// 附件读取专用的宽松鉴权:Authorization 头之外,接受 cfnote_t cookie(前端登录后写入,
// <img>/同源 fetch 自动携带,解决图片标签带不上请求头的问题)。
// 只允许用在 GET/HEAD 附件路由——写操作一律不认 cookie,避免引入 CSRF 面。
export async function getUserLoose(request: Request, env: Env): Promise<{ id: number; username: string } | null> {
  const viaHeader = await getUser(request, env)
  if (viaHeader) return viaHeader
  const m = /(?:^|;\s*)cfnote_t=([^;\s]+)/.exec(request.headers.get('Cookie') || '')
  if (!m) return null
  const payload = await verifyJWT(m[1], env.JWT_SECRET)
  if (!payload || !payload.uid) return null
  return { id: payload.uid as number, username: payload.username as string }
}
