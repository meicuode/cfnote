import { Hono } from 'hono'
import { ok, err, logSystem, isAllowedModel, DEFAULT_MODEL } from '../utils'
import {
  validateProviderInput, mergeDetected, parseStoredModels, cleanModelId, probeCandidates,
  AI_PROTOCOLS, EFFORT_LEVELS, MAX_MODELS,
  type AiProtocol, type Effort, type EffortScheme, type ModelEntry, type ProbeResult,
} from '../../src/lib/aiProviders'
import { classifyProbe, cleanChatMessages, PING_PROMPT, PROBE_PROMPT } from '../../src/lib/aiProtocol'
import { MASK_PREFIX } from '../../src/lib/notifyChannels'
import {
  loadProvider, findModelEntry, makeTarget, targetFor, toPublic, fetchModels, requestCompletion,
  streamChat, sseResponse, clip, type LlmTarget, type ExternalTarget,
} from '../llm'
import type { AppEnv } from '../types'
import type { Env } from '../../src/types'

// 外部 AI 渠道管理(P19):渠道增删改、模型检测、可用性测试、思考强度探测、对话测试。
// 渠道表与 settings 分开放的原因见 DESIGN §5:备份不导这张表,Key 结构性地不进备份。
// 上游失败一律回 502 而不是透传状态码——前端 useApi 见到 401 会当成登录过期直接登出。
export const ai = new Hono<AppEnv>()

const FULL_COLS = 'id, name, mode, protocol, base_url, api_key, allow_private, models, models_at, created_at, updated_at'

function readId(raw: string): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : 0
}

// GET /api/ai/providers - 渠道列表(Key 掩码;带模型列表,对话面板的选择器要用)
ai.get('/providers', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`SELECT ${FULL_COLS} FROM ai_providers ORDER BY id`).all<any>()
    return ok((results || []).map(toPublic))
  } catch (e: any) {
    return err('获取 AI 渠道失败: ' + e.message, 500)
  }
})

// POST /api/ai/providers - 新建渠道(不自动检测;前端保存后再调 detect,失败也不影响渠道本身)
ai.post('/providers', async (c) => {
  try {
    const v = validateProviderInput(await c.req.json().catch(() => ({})), false, MASK_PREFIX)
    if (!v.ok) return err(v.error)
    const p = v.value
    const r = await c.env.DB.prepare(
      'INSERT INTO ai_providers (name, mode, protocol, base_url, api_key, allow_private) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(p.name, p.mode, p.protocol, p.base_url, p.api_key, p.allow_private ? 1 : 0).run()
    const row = await loadProvider(c.env, Number(r.meta.last_row_id), true)
    return ok(row ? toPublic(row) : null)
  } catch (e: any) {
    return err('添加 AI 渠道失败: ' + e.message, 500)
  }
})
// PUT /api/ai/providers/:id - 改渠道。api_key 为空或仍是掩码 = 不改(同 settings 的掩码约定)
ai.put('/providers/:id', async (c) => {
  const id = readId(c.req.param('id'))
  try {
    const old = await loadProvider(c.env, id, true)
    if (!old) return err('渠道不存在', 404)
    const v = validateProviderInput(await c.req.json().catch(() => ({})), true, MASK_PREFIX)
    if (!v.ok) return err(v.error)
    const p = v.value
    const sets: string[] = []
    const vals: unknown[] = []
    for (const k of ['name', 'mode', 'protocol', 'base_url', 'api_key'] as const) {
      if (p[k] !== undefined) { sets.push(`${k} = ?`); vals.push(p[k]) }
    }
    if (p.allow_private !== undefined) { sets.push('allow_private = ?'); vals.push(p.allow_private ? 1 : 0) }
    // 换了上游地址或协议,旧的探测结果就不对了(模型列表留着,用户可以重新检测)
    const urlChanged = p.base_url !== undefined && p.base_url !== old.base_url
    const protoChanged = p.protocol !== undefined && p.protocol !== old.protocol
    if (urlChanged || protoChanged) {
      sets.push('models = ?')
      vals.push(JSON.stringify(dropStaleProbes(parseStoredModels(old.models), urlChanged)))
    }
    if (sets.length === 0) return ok(toPublic(old))
    sets.push("updated_at = datetime('now')")
    await c.env.DB.prepare(`UPDATE ai_providers SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run()
    const row = await loadProvider(c.env, id, true)
    return ok(row ? toPublic(row) : null)
  } catch (e: any) {
    return err('更新 AI 渠道失败: ' + e.message, 500)
  }
})

/** 地址变了:全部作废;只是协议变了:跟随渠道协议的模型作废,有自己协议覆盖的不受影响 */
function dropStaleProbes(models: ModelEntry[], all: boolean): ModelEntry[] {
  return models.map((m) => {
    if (!m.probe || (!all && m.protocol)) return m
    const { probe: _drop, ...rest } = m
    return rest
  })
}

// DELETE /api/ai/providers/:id - 删渠道(硬删:这是配置不是内容,和通知渠道一样不进回收站)。
// 删的正好是当前默认渠道时,把设置重置回 Workers AI——否则下一次对话就报「渠道已不存在」。
ai.delete('/providers/:id', async (c) => {
  const id = readId(c.req.param('id'))
  try {
    const p = await loadProvider(c.env, id)
    if (!p) return err('渠道不存在', 404)
    const cur = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'llm_provider'").first<{ value: string }>()
    const wasDefault = (cur?.value || '') === String(id)
    const stmts = [c.env.DB.prepare('DELETE FROM ai_providers WHERE id = ?').bind(id)]
    if (wasDefault) {
      stmts.push(upsertSetting(c.env, 'llm_provider', ''), upsertSetting(c.env, 'llm_model', DEFAULT_MODEL), upsertSetting(c.env, 'llm_effort', ''))
    }
    await c.env.DB.batch(stmts)
    return ok({ reset_default: wasDefault })
  } catch (e: any) {
    return err('删除 AI 渠道失败: ' + e.message, 500)
  }
})

function upsertSetting(env: Env, key: string, value: string) {
  return env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, value)
}
// POST /api/ai/providers/:id/detect - 拉模型列表,与已有的合并后存进 D1。
// 存 D1 而不是边缘缓存:Cache API 按数据中心存、随时可能被逐出,而这份列表要留着标星和探测结果。
ai.post('/providers/:id/detect', async (c) => {
  const id = readId(c.req.param('id'))
  try {
    const p = await loadProvider(c.env, id, true)
    if (!p) return err('渠道不存在', 404)
    let detected: ModelEntry[]
    try {
      detected = await fetchModels(p)
    } catch (e: any) {
      logSystem(c.env, 'warn', 'ai', `渠道「${p.name}」检测模型失败`, e.message)
      return err(e.message, 502)
    }
    const merged = mergeDetected(parseStoredModels(p.models), detected)
    await c.env.DB.prepare(
      "UPDATE ai_providers SET models = ?, models_at = datetime('now') WHERE id = ?"
    ).bind(JSON.stringify(merged), id).run()
    const row = await loadProvider(c.env, id, true)
    return ok(row ? toPublic(row) : null)
  } catch (e: any) {
    return err('检测模型失败: ' + e.message, 500)
  }
})

// POST /api/ai/providers/:id/test {model} - 可用性测试:发一句极短的话,不带思考参数,看通不通、多快。
// 结果不落库:可用性是会变的,存下来反而误导。
ai.post('/providers/:id/test', async (c) => {
  const id = readId(c.req.param('id'))
  try {
    const body = await c.req.json<{ model?: unknown }>().catch(() => ({} as { model?: unknown }))
    const model = cleanModelId(body.model)
    if (!model) return err('模型 ID 不对')
    const p = await loadProvider(c.env, id)
    if (!p) return err('渠道不存在', 404)
    const t = makeTarget(p, model, await findModelEntry(c.env, id, model), '')
    const r = await requestCompletion(t, [{ role: 'user', content: PING_PROMPT }])
    const okCall = r.status >= 200 && r.status < 300 && !!r.completion
    return ok({
      ok: okCall,
      status: r.status,
      ms: r.ms,
      error: okCall ? undefined : (r.error || '上游没有返回内容'),
      reply: r.completion ? clip(r.completion.text || r.completion.think, 100) : undefined,
      usage: r.completion?.usage,
    })
  } catch (e: any) {
    return err('测试失败: ' + e.message, 500)
  }
})

// POST /api/ai/providers/:id/probe {model, effort} - 探测一个思考档位。一次只探一档,前端逐档调;
// 同一个模型的几档请顺序调,不要并发(结果是读改写合并进同一个条目的)。
ai.post('/providers/:id/probe', async (c) => {
  const id = readId(c.req.param('id'))
  try {
    const body = await c.req.json<{ model?: unknown; effort?: unknown }>().catch(() => ({} as { model?: unknown; effort?: unknown }))
    const model = cleanModelId(body.model)
    if (!model) return err('模型 ID 不对')
    const effort = String(body.effort ?? '') as Effort
    if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) return err('不支持的思考强度')
    const p = await loadProvider(c.env, id)
    if (!p) return err('渠道不存在', 404)
    const entry = await findModelEntry(c.env, id, model)
    if (!entry) return err('模型不在这个渠道的列表里,先检测或手动添加', 404)
    const protocol = entry.protocol ?? p.protocol
    const cand = probeCandidates(model, protocol)
    if (cand.scheme === 'always') return err('这个模型是常开推理,没有可选的思考档位')
    // 按候选方式发参,不经过 effortOptions 的过滤——探测就是要试一个还不确定的档位
    const t: ExternalTarget = { kind: 'external', provider: p, model, protocol, effort, scheme: cand.scheme }
    const r = await requestCompletion(t, [{ role: 'user', content: PROBE_PROMPT }])
    const outcome = classifyProbe(r.status, r.completion)
    const result: ProbeResult = { outcome }
    if (outcome === 'rejected' || outcome === 'error') result.detail = clip(r.error || '上游没有返回内容', 300)
    if (r.completion?.usage.reasoning !== undefined) result.reasoning_tokens = r.completion.usage.reasoning
    await saveProbe(c.env, id, entry, cand.scheme, effort, result)
    return ok({ effort, scheme: cand.scheme, ms: r.ms, ...result })
  } catch (e: any) {
    return err('探测失败: ' + e.message, 500)
  }
})
// ---- 单个模型条目的原子修改 ----
// 标星、改协议、写探测结果都只动 models 里的一个条目。读出整列改完再写回的话,
// 两个并发请求(比如探测 A 模型的同时给 B 模型标星)后写的会把先写的覆盖掉,所以交给 SQLite 的 JSON 函数就地改。

const MODELS_JSON = "CASE WHEN json_valid(models) THEN models ELSE '[]' END"
const MODEL_INDEX = `(SELECT j.key FROM json_each(${MODELS_JSON}) j WHERE json_extract(j.value, '$.id') = ?2 LIMIT 1)`

type FieldOp = { set: 'starred' | 'protocol' | 'probe'; value: unknown } | { remove: 'starred' | 'protocol' | 'probe' }

/** 改一个模型条目的若干字段;模型不在列表里返回 false */
async function editModel(env: Env, providerId: number, modelId: string, ops: FieldOp[]): Promise<boolean> {
  let expr = MODELS_JSON
  const extra: unknown[] = []
  for (const op of ops) {
    const n = extra.length + 3
    if ('set' in op) {
      expr = `json_set(${expr}, '$[' || ${MODEL_INDEX} || '].${op.set}', json(?${n}))`
      extra.push(JSON.stringify(op.value))
    } else {
      expr = `json_remove(${expr}, '$[' || ${MODEL_INDEX} || '].${op.remove}')`
    }
  }
  const r = await env.DB.prepare(
    `UPDATE ai_providers SET models = ${expr} WHERE id = ?1 AND ${MODEL_INDEX} IS NOT NULL`
  ).bind(providerId, modelId, ...extra).run()
  return (r.meta.changes ?? 0) > 0
}

/**
 * 把一档的探测结果合并进模型条目。这次是 error(网络、限流)而这一档之前有过正经结论的,保留旧结论——
 * 一次抖动不该抹掉已经知道的事。发参方式变了(协议改过)的旧结果整个作废。
 */
async function saveProbe(
  env: Env, providerId: number, entry: ModelEntry, scheme: EffortScheme, effort: Effort, result: ProbeResult,
): Promise<void> {
  const prev = entry.probe?.scheme === scheme ? entry.probe.results : {}
  const keep = result.outcome === 'error' && prev[effort] && prev[effort]!.outcome !== 'error'
  const results = { ...prev, [effort]: keep ? prev[effort] : result }
  await editModel(env, providerId, entry.id, [{ set: 'probe', value: { at: new Date().toISOString(), scheme, results } }])
}

async function findEntryOrNull(env: Env, providerId: number, modelId: string): Promise<ModelEntry | null> {
  return (await findModelEntry(env, providerId, modelId)) ?? null
}

// PATCH /api/ai/providers/:id/models - 改模型列表里的一项。
// 模型 ID 里有斜杠(anthropic/claude-…),放请求体里而不是路径参数。
// {id, add:true} 手动添加 / {id, remove:true} 删除 / {id, starred} 标星 / {id, protocol} 协议覆盖(空串 = 跟随渠道)
ai.patch('/providers/:id/models', async (c) => {
  const providerId = readId(c.req.param('id'))
  try {
    const body = await c.req.json<any>().catch(() => ({}))
    const modelId = cleanModelId(body?.id)
    if (!modelId) return err('模型 ID 不对(不能为空、最长 200 字、不能含控制字符)')
    const p = await loadProvider(c.env, providerId)
    if (!p) return err('渠道不存在', 404)

    if (body.add === true) {
      const st = await c.env.DB.prepare(
        `SELECT json_array_length(${MODELS_JSON}) AS n,
                EXISTS(SELECT 1 FROM json_each(${MODELS_JSON}) j WHERE json_extract(j.value, '$.id') = ?2) AS has
         FROM ai_providers WHERE id = ?1`
      ).bind(providerId, modelId).first<{ n: number; has: number }>()
      if (st?.has) return err('这个模型已经在列表里了')
      if ((st?.n ?? 0) >= MAX_MODELS) return err(`一个渠道最多 ${MAX_MODELS} 个模型`)
      const entry: ModelEntry = { id: modelId, manual: true }
      await c.env.DB.prepare(
        `UPDATE ai_providers SET models = json_insert(${MODELS_JSON}, '$[#]', json(?2)) WHERE id = ?1`
      ).bind(providerId, JSON.stringify(entry)).run()
      return ok(entry)
    }

    if (body.remove === true) {
      const r = await c.env.DB.prepare(
        `UPDATE ai_providers SET models = json_remove(${MODELS_JSON}, '$[' || ${MODEL_INDEX} || ']')
         WHERE id = ?1 AND ${MODEL_INDEX} IS NOT NULL`
      ).bind(providerId, modelId).run()
      if ((r.meta.changes ?? 0) === 0) return err('模型不在列表里', 404)
      return ok({ removed: modelId })
    }

    const ops: FieldOp[] = []
    if (body.starred !== undefined) ops.push(body.starred === true ? { set: 'starred', value: true } : { remove: 'starred' })
    if (body.protocol !== undefined) {
      const proto = String(body.protocol || '')
      if (proto && !AI_PROTOCOLS.includes(proto as AiProtocol)) return err('不支持的协议')
      // 和渠道协议相同就等于没覆盖,存成空:以后渠道改协议时它会跟着走
      ops.push(proto && proto !== p.protocol ? { set: 'protocol', value: proto } : { remove: 'protocol' })
      // 协议一变,发参方式和上游行为都可能变,探测结果作废
      ops.push({ remove: 'probe' })
    }
    if (ops.length === 0) return err('没有要改的内容')
    if (!(await editModel(c.env, providerId, modelId, ops))) return err('模型不在列表里', 404)
    return ok(await findEntryOrNull(c.env, providerId, modelId))
  } catch (e: any) {
    return err('修改模型失败: ' + e.message, 500)
  }
})
/** 对话测试的目标:provider_id 为空 = Workers AI(仍走白名单) */
async function chatTestTarget(env: Env, body: any): Promise<LlmTarget | string> {
  const providerId = String(body?.provider_id ?? '')
  const model = cleanModelId(body?.model)
  if (!model) return '请选择模型'
  if (!providerId) return isAllowedModel(model) ? { kind: 'workers-ai', model } : '不支持的 Workers AI 模型'
  const p = await loadProvider(env, readId(providerId))
  if (!p) return '渠道不存在'
  return targetFor(env, p, model, String(body?.effort ?? ''))
}

// POST /api/ai/chat-test {provider_id, model, effort, messages} - 对话测试弹窗用的无状态 SSE:
// 不检索知识库、不落库、不埋点(测试不该算进统计)。done 事件带首字耗时、总耗时、token 用量、
// 以及实际发出去的思考档位(档位不被该模型支持时会被丢掉,界面要能看出来)。
ai.post('/chat-test', async (c) => {
  try {
    const body = await c.req.json<any>().catch(() => ({}))
    const messages = cleanChatMessages(body?.messages)
    if (!messages) return err('消息格式不对:最多 40 条,最后一条须是用户消息')
    const target = await chatTestTarget(c.env, body)
    if (typeof target === 'string') return err(target)
    const env = c.env
    return sseResponse(c.executionCtx, async (send) => {
      const started = Date.now()
      let firstMs: number | null = null
      let usage = {}
      for await (const ch of streamChat(env, target, messages)) {
        if (ch.type === 'usage') { usage = ch.usage; continue }
        if (firstMs === null) firstMs = Date.now() - started
        await send({ type: ch.type === 'think' ? 'think' : 'delta', text: ch.text })
      }
      await send({
        type: 'done',
        first_token_ms: firstMs,
        total_ms: Date.now() - started,
        usage,
        effort: target.kind === 'external' ? target.effort : '',
      })
    })
  } catch (e: any) {
    return err('对话测试失败: ' + e.message, 500)
  }
})
