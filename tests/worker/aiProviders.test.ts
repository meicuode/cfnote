import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, dropAll, bootstrap, newNotebook, newArticle } from './_helpers'
import { ragSearch } from '../../worker/utils'

// P19 外部 AI 渠道。测试环境没有 AI / Vectorize 绑定,也不出网:
// 这里只测不需要真上游的部分——增删改与掩码、Key 不外泄、设置联合校验、模型条目的原子修改、
// 渠道失效时的报错路径、私密笔记过滤。真上游的检测 / 测试 / 探测 / 对话见 docs/verify.md O 节,
// 协议适配器见 tests/llm.test.ts(注入假 fetch)。

const KEY = 'sk-live-ZYXWVUTSRQPONMLKJIHG9876'

async function newProvider(token: string, over: Record<string, unknown> = {}) {
  const res = await api('/api/ai/providers', {
    method: 'POST', token, body: j({ name: '中转 A', base_url: 'https://relay.example.com/v1/chat/completions', api_key: KEY, ...over }),
  })
  expect(res.body.ok, '建渠道失败: ' + res.body.error).toBe(true)
  return res.body.data as any
}

async function setting(key: string): Promise<string | null> {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>()
  return r?.value ?? null
}

async function storedModels(id: number): Promise<any[]> {
  const r = await env.DB.prepare('SELECT models FROM ai_providers WHERE id = ?').bind(id).first<{ models: string | null }>()
  return r?.models ? JSON.parse(r.models) : []
}

describe('渠道增删改与 Key 掩码', () => {
  beforeEach(dropAll)

  it('新建:Base URL 规整、Key 只露后四位;库里是真值', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    expect(p.base_url).toBe('https://relay.example.com/v1')
    expect(p.api_key).toBe('****9876')
    expect(p.mode).toBe('relay')
    expect(p.protocol).toBe('openai-chat')
    expect(p.allow_private).toBe(false)
    expect(p.models).toEqual([])
    const row = await env.DB.prepare('SELECT api_key FROM ai_providers WHERE id = ?').bind(p.id).first<{ api_key: string }>()
    expect(row!.api_key).toBe(KEY)

    const list = await api('/api/ai/providers', { token })
    expect(list.raw).not.toContain(KEY)
    expect(list.body.data).toHaveLength(1)
  })

  it('Key 不出现在 GET /api/settings 和 /api/export 里', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    expect((await api('/api/settings', { method: 'PUT', token, body: j({ llm_provider: String(p.id), llm_model: 'gpt-5' }) })).body.ok).toBe(true)
    for (const path of ['/api/settings', '/api/export', '/api/export?versions=1']) {
      const r = await api(path, { token })
      expect(r.status, path).toBe(200)
      expect(r.raw, path).not.toContain(KEY)
      expect(r.raw, path).not.toContain(KEY.slice(8, 20))
    }
  })
  it('PUT:Key 为空或仍是掩码就保留原值,给新值才换', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    const put = (body: unknown) => api(`/api/ai/providers/${p.id}`, { method: 'PUT', token, body: j(body) })
    expect((await put({ name: '改名', api_key: '****9876' })).body.data.name).toBe('改名')
    expect((await put({ api_key: '' })).body.ok).toBe(true)
    let row = await env.DB.prepare('SELECT api_key, name FROM ai_providers WHERE id = ?').bind(p.id).first<any>()
    expect(row).toEqual({ api_key: KEY, name: '改名' })
    expect((await put({ api_key: 'sk-new-key-000011112222' })).body.data.api_key).toBe('****2222')
    row = await env.DB.prepare('SELECT api_key FROM ai_providers WHERE id = ?').bind(p.id).first<any>()
    expect(row.api_key).toBe('sk-new-key-000011112222')
  })

  it('非法输入 400;不存在的渠道 404', async () => {
    const token = await bootstrap()
    for (const bad of [{ base_url: 'file:///etc/passwd' }, { base_url: 'https://u:p@x.com' }, { api_key: '' }, { name: '' }, { protocol: 'gemini' }]) {
      const r = await api('/api/ai/providers', { method: 'POST', token, body: j({ name: 'x', base_url: 'https://x.com', api_key: KEY, ...bad }) })
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
    expect((await api('/api/ai/providers/999', { method: 'PUT', token, body: j({ name: 'x' }) })).status).toBe(404)
    expect((await api('/api/ai/providers/999', { method: 'DELETE', token })).status).toBe(404)
    expect((await api('/api/ai/providers/abc/detect', { method: 'POST', token })).status).toBe(404)
  })

  it('改协议或地址时,旧的探测结果作废(有自己协议覆盖的模型只在改地址时作废)', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    const probe = { at: 'x', scheme: 'openai', results: { high: { outcome: 'effective' } } }
    const seed = [{ id: 'a', probe }, { id: 'b', protocol: 'anthropic', probe: { ...probe, scheme: 'anthropic-adaptive' } }]
    await env.DB.prepare('UPDATE ai_providers SET models = ? WHERE id = ?').bind(JSON.stringify(seed), p.id).run()

    await api(`/api/ai/providers/${p.id}`, { method: 'PUT', token, body: j({ protocol: 'openai-responses' }) })
    let models = await storedModels(p.id)
    expect(models[0].probe).toBeUndefined()
    expect(models[1].probe).toBeDefined()

    await api(`/api/ai/providers/${p.id}`, { method: 'PUT', token, body: j({ base_url: 'https://other.example.com' }) })
    models = await storedModels(p.id)
    expect(models.map((m) => m.id)).toEqual(['a', 'b'])
    expect(models[1].probe).toBeUndefined()
  })

  it('需要登录', async () => {
    await bootstrap()
    expect((await api('/api/ai/providers')).status).toBe(401)
  })
})
describe('PUT /api/settings 的渠道 / 模型 / 思考强度联合校验', () => {
  beforeEach(dropAll)

  const put = (token: string, body: unknown) => api('/api/settings', { method: 'PUT', token, body: j(body) })

  it('Workers AI 仍走白名单(老界面只发 llm_model 的行为不变)', async () => {
    const token = await bootstrap()
    expect((await put(token, { llm_model: '@cf/qwen/qwq-32b' })).body.ok).toBe(true)
    expect((await put(token, { llm_model: 'gpt-5' })).body.error).toBe('不支持的模型')
    expect((await put(token, { llm_model: 42 })).status).toBe(400)
  })

  it('外部渠道:渠道必须存在,换渠道必须同时给模型,档位只认已知值', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    const id = String(p.id)
    expect((await put(token, { llm_provider: '999', llm_model: 'gpt-5' })).body.error).toBe('AI 渠道不存在')
    expect((await put(token, { llm_provider: id })).body.error).toBe('切换渠道时需要同时选择模型')
    expect((await put(token, { llm_provider: id, llm_model: '' })).body.error).toBe('请选择模型')
    expect((await put(token, { llm_provider: id, llm_model: 'gpt-5', llm_effort: 'turbo' })).body.error).toBe('不支持的思考强度')

    expect((await put(token, { llm_provider: id, llm_model: 'anthropic/claude-opus-4-7', llm_effort: 'high' })).body.ok).toBe(true)
    expect(await setting('llm_provider')).toBe(id)
    expect(await setting('llm_model')).toBe('anthropic/claude-opus-4-7')
    // 同一渠道内换模型:不需要再带 llm_provider;外部模型不走 Workers AI 白名单
    expect((await put(token, { llm_model: 'gpt-5' })).body.ok).toBe(true)
  })

  it('切回 Workers AI 时模型必须是白名单里的', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    expect((await put(token, { llm_provider: String(p.id), llm_model: 'gpt-5' })).body.ok).toBe(true)
    expect((await put(token, { llm_provider: '', llm_model: 'gpt-5' })).body.error).toBe('不支持的模型')
    expect((await put(token, { llm_provider: '', llm_model: '@cf/meta/llama-3.1-8b-instruct', llm_effort: '' })).body.ok).toBe(true)
    expect(await setting('llm_provider')).toBe('')
  })
})

describe('删除渠道', () => {
  beforeEach(dropAll)

  it('删的是当前默认渠道:设置重置回 Workers AI;删别的不动设置', async () => {
    const token = await bootstrap()
    const a = await newProvider(token)
    const b = await newProvider(token, { name: '中转 B' })
    await api('/api/settings', { method: 'PUT', token, body: j({ llm_provider: String(a.id), llm_model: 'gpt-5', llm_effort: 'high' }) })

    const delB = await api(`/api/ai/providers/${b.id}`, { method: 'DELETE', token })
    expect(delB.body.data).toEqual({ reset_default: false })
    expect(await setting('llm_provider')).toBe(String(a.id))

    const delA = await api(`/api/ai/providers/${a.id}`, { method: 'DELETE', token })
    expect(delA.body.data).toEqual({ reset_default: true })
    expect(await setting('llm_provider')).toBe('')
    expect(await setting('llm_model')).toBe('@cf/meta/llama-3.3-70b-instruct-fp8-fast')
    expect(await setting('llm_effort')).toBe('')
    expect((await api('/api/ai/providers', { token })).body.data).toEqual([])
  })

  it('渠道被绕过接口删掉时:对话报错说清楚,而且不留下一条没有回复的提问', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    await api('/api/settings', { method: 'PUT', token, body: j({ llm_provider: String(p.id), llm_model: 'gpt-5' }) })
    await env.DB.prepare('DELETE FROM ai_providers WHERE id = ?').bind(p.id).run()

    const conv = await api('/api/conversations', { method: 'POST', token })
    const send = await api(`/api/conversations/${conv.body.data.id}/messages`, { method: 'POST', token, body: j({ content: '你好', stream: true }) })
    expect(send.status).toBe(400)
    expect(send.body.error).toContain('渠道已不存在')
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>()
    expect(n!.n).toBe(0)

    const qa = await api('/api/search/ai', { method: 'POST', token, body: j({ query: '你好' }) })
    expect(qa.body.ok).toBe(false)
    expect(qa.body.error).toContain('渠道已不存在')
  })
})
describe('PATCH /api/ai/providers/:id/models(就地改一个条目)', () => {
  beforeEach(dropAll)

  it('手动添加、标星、协议覆盖、删除', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    const patch = (body: unknown) => api(`/api/ai/providers/${p.id}/models`, { method: 'PATCH', token, body: j(body) })

    expect((await patch({ id: 'anthropic/claude-opus-4-7', add: true })).body.data).toEqual({ id: 'anthropic/claude-opus-4-7', manual: true })
    expect((await patch({ id: 'anthropic/claude-opus-4-7', add: true })).body.error).toBe('这个模型已经在列表里了')
    expect((await patch({ id: 'gpt-5', add: true })).body.ok).toBe(true)

    expect((await patch({ id: 'gpt-5', starred: true })).body.data).toEqual({ id: 'gpt-5', manual: true, starred: true })
    expect((await patch({ id: 'gpt-5', starred: false })).body.data).toEqual({ id: 'gpt-5', manual: true })

    const proto = await patch({ id: 'anthropic/claude-opus-4-7', protocol: 'anthropic' })
    expect(proto.body.data.protocol).toBe('anthropic')
    // 和渠道协议相同 = 没有覆盖
    expect((await patch({ id: 'anthropic/claude-opus-4-7', protocol: 'openai-chat' })).body.data.protocol).toBeUndefined()
    expect((await patch({ id: 'gpt-5', protocol: 'gemini' })).status).toBe(400)

    expect((await patch({ id: 'gpt-5', remove: true })).body.data).toEqual({ removed: 'gpt-5' })
    expect((await patch({ id: 'gpt-5', remove: true })).status).toBe(404)
    expect((await patch({ id: 'nope', starred: true })).status).toBe(404)
    expect((await patch({ id: '', add: true })).status).toBe(400)
    expect((await storedModels(p.id)).map((m) => m.id)).toEqual(['anthropic/claude-opus-4-7'])
  })

  it('改协议覆盖时清掉该模型的探测结果,别的字段和别的模型不受影响', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    const probe = { at: 'x', scheme: 'openai', results: { low: { outcome: 'accepted' } } }
    await env.DB.prepare('UPDATE ai_providers SET models = ? WHERE id = ?')
      .bind(JSON.stringify([{ id: 'a', starred: true, probe }, { id: 'b', probe }]), p.id).run()
    await api(`/api/ai/providers/${p.id}/models`, { method: 'PATCH', token, body: j({ id: 'a', protocol: 'anthropic' }) })
    expect(await storedModels(p.id)).toEqual([{ id: 'a', starred: true, protocol: 'anthropic' }, { id: 'b', probe }])
  })

  it('并发给两个模型标星,两个都生效(不是读出整列改完再写回)', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    await env.DB.prepare('UPDATE ai_providers SET models = ? WHERE id = ?')
      .bind(JSON.stringify([{ id: 'a' }, { id: 'b' }, { id: 'c' }]), p.id).run()
    const star = (id: string) => api(`/api/ai/providers/${p.id}/models`, { method: 'PATCH', token, body: j({ id, starred: true }) })
    await Promise.all([star('a'), star('c')])
    expect(await storedModels(p.id)).toEqual([{ id: 'a', starred: true }, { id: 'b' }, { id: 'c', starred: true }])
  })

  it('models 列是坏 JSON 时当空列表处理,添加照常', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    await env.DB.prepare("UPDATE ai_providers SET models = '{bad' WHERE id = ?").bind(p.id).run()
    expect((await api(`/api/ai/providers/${p.id}/models`, { method: 'PATCH', token, body: j({ id: 'x', add: true }) })).body.ok).toBe(true)
    expect(await storedModels(p.id)).toEqual([{ id: 'x', manual: true }])
    expect((await api('/api/ai/providers', { token })).body.data[0].models).toEqual([{ id: 'x', manual: true }])
  })
})

describe('不出网的输入校验(探测 / 测试 / 对话测试)', () => {
  beforeEach(dropAll)

  it('探测:档位不认识 400、模型不在列表 404、常开推理模型没有档位可探 400', async () => {
    const token = await bootstrap()
    const p = await newProvider(token)
    await env.DB.prepare('UPDATE ai_providers SET models = ? WHERE id = ?').bind(JSON.stringify([{ id: 'deepseek-reasoner' }]), p.id).run()
    const probe = (body: unknown) => api(`/api/ai/providers/${p.id}/probe`, { method: 'POST', token, body: j(body) })
    expect((await probe({ model: 'deepseek-reasoner', effort: 'turbo' })).status).toBe(400)
    expect((await probe({ model: 'gpt-5', effort: 'high' })).status).toBe(404)
    expect((await probe({ model: 'deepseek-reasoner', effort: 'high' })).body.error).toContain('常开推理')
    expect((await api(`/api/ai/providers/${p.id}/test`, { method: 'POST', token, body: j({ model: '' }) })).status).toBe(400)
  })

  it('对话测试:消息格式不对、Workers AI 模型不在白名单、渠道不存在都是 400', async () => {
    const token = await bootstrap()
    const t = (body: unknown) => api('/api/ai/chat-test', { method: 'POST', token, body: j(body) })
    const messages = [{ role: 'user', content: '你好' }]
    expect((await t({ model: '@cf/qwen/qwq-32b', messages: [{ role: 'assistant', content: 'x' }] })).status).toBe(400)
    expect((await t({ model: 'gpt-5', messages })).body.error).toBe('不支持的 Workers AI 模型')
    expect((await t({ provider_id: '42', model: 'gpt-5', messages })).body.error).toBe('渠道不存在')
  })
})
describe('ragSearch 的私密笔记过滤', () => {
  beforeEach(dropAll)

  it('includePrivate:false 时私密笔记不进检索结果;默认(Workers AI)照旧带上', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const pub = await newArticle(token, nb, '公开笔记')
    const priv = await newArticle(token, nb, '私密笔记')
    await env.DB.prepare('UPDATE articles SET is_private = 1 WHERE id = ?').bind(priv).run()
    const user = await env.DB.prepare('SELECT id FROM users LIMIT 1').first<{ id: number }>()
    for (const [id, text] of [[pub, '公开片段'], [priv, '私密片段']] as const) {
      await env.DB.prepare('INSERT INTO chunks (article_id, chunk_index, chunk_text, vector_id) VALUES (?, 0, ?, ?)')
        .bind(id, text, `v${id}`).run()
    }
    // 测试环境没有 AI / Vectorize 绑定:换成假的,D1 用真的。私密的排第一,确认不是靠 topK 截掉的
    const fake = {
      DB: env.DB,
      AI: { run: async () => ({ data: [[0.1, 0.2]] }) },
      VECTORIZE: {
        query: async () => ({
          matches: [
            { id: `v${priv}`, score: 0.9, metadata: { article_id: priv, chunk_index: 0 } },
            { id: `v${pub}`, score: 0.8, metadata: { article_id: pub, chunk_index: 0 } },
          ],
        }),
      },
    } as any

    const external = await ragSearch(fake, '片段', user!.id, 5, { includePrivate: false })
    expect(external.sources.map((s) => s.article_id)).toEqual([pub])
    expect(external.contextParts.join('\n')).not.toContain('私密片段')
    expect(external.contextParts[0]).toBe('[1] 公开片段')

    const local = await ragSearch(fake, '片段', user!.id, 5)
    expect(local.sources.map((s) => s.article_id)).toEqual([priv, pub])
  })
})
