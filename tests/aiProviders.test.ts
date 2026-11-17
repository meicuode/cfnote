import { describe, it, expect } from 'vitest'
import {
  normalizeBaseUrl, endpointUrl, modelsUrl, authHeaders, parseModelList, mergeDetected, parseStoredModels,
  claudeVersion, effortRule, probeCandidates, effortOptions, validateProviderInput, cleanModelId,
  type ModelEntry,
} from '../src/lib/aiProviders'

describe('normalizeBaseUrl', () => {
  it('裸域名补 /v1,去掉末尾斜杠', () => {
    expect(normalizeBaseUrl('https://api.x.com')).toBe('https://api.x.com/v1')
    expect(normalizeBaseUrl(' https://api.x.com/ ')).toBe('https://api.x.com/v1')
    expect(normalizeBaseUrl('http://localhost:3000')).toBe('http://localhost:3000/v1')
  })

  it('剥掉用户粘进来的端点后缀,保留中转站的路径前缀', () => {
    expect(normalizeBaseUrl('https://api.x.com/v1/chat/completions')).toBe('https://api.x.com/v1')
    expect(normalizeBaseUrl('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com/v1')
    expect(normalizeBaseUrl('https://relay.x/openai/v1/')).toBe('https://relay.x/openai/v1')
    expect(normalizeBaseUrl('https://relay.x/v1/responses')).toBe('https://relay.x/v1')
    expect(normalizeBaseUrl('https://relay.x/v1/models')).toBe('https://relay.x/v1')
  })

  it('查询串丢掉', () => {
    expect(normalizeBaseUrl('https://x.com/v1?key=abc')).toBe('https://x.com/v1')
  })

  it('非 http(s)、带用户名密码、不是 URL 的一律拒绝', () => {
    for (const bad of ['', 'not a url', 'ftp://x.com', 'javascript:alert(1)', 'file:///etc/passwd', 'https://u:p@x.com/v1']) {
      expect(normalizeBaseUrl(bad), bad).toBeNull()
    }
  })
})

describe('请求地址与鉴权头', () => {
  it('endpointUrl 按协议拼端点', () => {
    expect(endpointUrl('https://x/v1', 'openai-chat')).toBe('https://x/v1/chat/completions')
    expect(endpointUrl('https://x/v1', 'openai-responses')).toBe('https://x/v1/responses')
    expect(endpointUrl('https://x/v1/', 'anthropic')).toBe('https://x/v1/messages')
  })

  it('Anthropic 的 /models 带 limit=1000,其余不带', () => {
    expect(modelsUrl('https://x/v1', 'anthropic')).toBe('https://x/v1/models?limit=1000')
    expect(modelsUrl('https://x/v1', 'openai-chat')).toBe('https://x/v1/models')
  })

  it('Anthropic 用 x-api-key,Bearer 回退时两个头都带;OpenAI 只有 Bearer', () => {
    expect(authHeaders('anthropic', 'k')).toEqual({ 'x-api-key': 'k', 'anthropic-version': '2023-06-01' })
    expect(authHeaders('anthropic', 'k', true)).toEqual({ Authorization: 'Bearer k', 'anthropic-version': '2023-06-01' })
    expect(authHeaders('openai-chat', 'k')).toEqual({ Authorization: 'Bearer k' })
  })
})
describe('parseModelList', () => {
  it('OpenAI / Anthropic 的 { data: [{ id }] }', () => {
    const list = parseModelList({ object: 'list', data: [{ id: 'gpt-5', object: 'model' }, { id: 'claude-opus-4-5', type: 'model' }] })
    expect(list.map((m) => m.id)).toEqual(['gpt-5', 'claude-opus-4-5'])
    expect(list[0].meta).toBeUndefined()
  })

  it('直接回数组(元素是字符串或对象)', () => {
    expect(parseModelList(['a', { id: 'b' }]).map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('Gemini 风格 { models: [{ name: "models/x" }] } 去掉 models/ 前缀', () => {
    expect(parseModelList({ models: [{ name: 'models/gemini-2.5-pro' }] }).map((m) => m.id)).toEqual(['gemini-2.5-pro'])
  })

  it('去重、跳过空 ID 与控制字符', () => {
    const list = parseModelList({ data: [{ id: 'a' }, { id: 'a' }, { id: '' }, { id: 'x\ny' }, {}, null, 42] })
    expect(list.map((m) => m.id)).toEqual(['a'])
  })

  it('认不出的形状返回空列表而不是抛错', () => {
    expect(parseModelList(null)).toEqual([])
    expect(parseModelList({ error: 'nope' })).toEqual([])
    expect(parseModelList('html')).toEqual([])
  })

  it('能力字段:OpenRouter supported_parameters、effort 取值、new-api 端点类型', () => {
    const [a, b, c] = parseModelList({
      data: [
        { id: 'a', supported_parameters: ['tools', 'reasoning'] },
        { id: 'b', reasoning_options: { effort: { values: ['low', 'high', 'bogus'] } } },
        { id: 'c', supported_endpoint_types: ['openai', 'anthropic'] },
      ],
    })
    expect(a.meta).toEqual({ reasoning: true })
    expect(b.meta).toEqual({ reasoning: true, efforts: ['low', 'high'] })
    expect(c.meta).toEqual({ endpoints: ['openai', 'anthropic'] })
  })
})

describe('mergeDetected', () => {
  const probe = { at: '2026-01-01', scheme: 'openai' as const, results: { high: { outcome: 'effective' as const } } }

  it('保留标星、协议覆盖、探测结果;上游没了的非手动模型丢掉;手动模型留着', () => {
    const prev: ModelEntry[] = [
      { id: 'kept', starred: true, protocol: 'anthropic', probe },
      { id: 'gone' },
      { id: 'mine', manual: true },
    ]
    const merged = mergeDetected(prev, [{ id: 'kept', meta: { reasoning: true } }, { id: 'new' }])
    expect(merged).toEqual([
      { id: 'kept', meta: { reasoning: true }, starred: true, protocol: 'anthropic', probe },
      { id: 'new' },
      { id: 'mine', manual: true },
    ])
  })

  it('手动加的模型后来被上游列出来了:按上游的来,不重复', () => {
    const merged = mergeDetected([{ id: 'x', manual: true, starred: true }], [{ id: 'x' }])
    expect(merged).toEqual([{ id: 'x', starred: true }])
  })
})

describe('parseStoredModels / cleanModelId', () => {
  it('坏 JSON、非数组、缺 id 的条目都不抛', () => {
    expect(parseStoredModels(null)).toEqual([])
    expect(parseStoredModels('{bad')).toEqual([])
    expect(parseStoredModels('{"a":1}')).toEqual([])
    expect(parseStoredModels('[{"id":"a"},{"x":1},null]')).toEqual([{ id: 'a' }])
  })

  it('模型 ID:去空白,放行斜杠和方括号前缀,拒绝空、超长、控制字符', () => {
    expect(cleanModelId('  anthropic/claude-opus-4-5 ')).toBe('anthropic/claude-opus-4-5')
    expect(cleanModelId('[官转] gpt-5')).toBe('[官转] gpt-5')
    expect(cleanModelId('')).toBeNull()
    expect(cleanModelId('a'.repeat(201))).toBeNull()
    expect(cleanModelId('a\u0000b')).toBeNull()
    expect(cleanModelId(42)).toBeNull()
  })
})
describe('claudeVersion', () => {
  it('新旧两种命名都认,8 位日期不当版本号', () => {
    expect(claudeVersion('claude-opus-4-5-20251101')).toEqual([4, 5])
    expect(claudeVersion('claude-sonnet-4-20250514')).toEqual([4, 0])
    expect(claudeVersion('claude-3-7-sonnet-20250219')).toEqual([3, 7])
    expect(claudeVersion('claude-3-5-haiku-latest')).toEqual([3, 5])
    expect(claudeVersion('claude-opus-5-5')).toEqual([5, 5])
    expect(claudeVersion('claude-sonnet-4.6')).toEqual([4, 6])
  })

  it('中转站前缀不影响', () => {
    expect(claudeVersion('anthropic/claude-sonnet-4-5')).toEqual([4, 5])
    expect(claudeVersion('[官转] claude-opus-4-7')).toEqual([4, 7])
  })

  it('不是 Claude 返回 null', () => {
    expect(claudeVersion('gpt-5')).toBeNull()
  })
})

describe('effortRule', () => {
  it('Anthropic 协议:4.7 起 adaptive 带 xhigh,4.6 不带;3.7~4.5 走 budget;更老的不思考', () => {
    expect(effortRule('claude-opus-5-5', 'anthropic')).toEqual({ scheme: 'anthropic-adaptive', levels: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(effortRule('claude-opus-4-7', 'anthropic').levels).toContain('xhigh')
    expect(effortRule('claude-sonnet-4-6', 'anthropic')).toEqual({ scheme: 'anthropic-adaptive', levels: ['low', 'medium', 'high', 'max'] })
    expect(effortRule('claude-sonnet-4-5-20250929', 'anthropic').scheme).toBe('anthropic-budget')
    expect(effortRule('claude-sonnet-4-20250514', 'anthropic').scheme).toBe('anthropic-budget')
    expect(effortRule('claude-3-7-sonnet-20250219', 'anthropic').scheme).toBe('anthropic-budget')
    expect(effortRule('claude-3-5-haiku-latest', 'anthropic').scheme).toBe('none')
  })

  it('Anthropic 协议下的非 Claude 模型不发思考参数', () => {
    expect(effortRule('glm-4.6', 'anthropic').scheme).toBe('none')
  })

  it('OpenAI 协议:o 系列、gpt-5 各代的档位子集', () => {
    expect(effortRule('o3-mini', 'openai-chat')).toEqual({ scheme: 'openai', levels: ['low', 'medium', 'high'] })
    expect(effortRule('o1-mini', 'openai-chat').scheme).toBe('always')
    expect(effortRule('gpt-5', 'openai-chat').levels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortRule('gpt-5-mini', 'openai-responses').levels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(effortRule('gpt-5.1', 'openai-chat').levels).toEqual(['none', 'low', 'medium', 'high'])
    expect(effortRule('gpt-5.2', 'openai-chat').levels).toEqual(['none', 'low', 'medium', 'high', 'xhigh'])
    expect(effortRule('gpt-5-chat-latest', 'openai-chat').scheme).toBe('none')
    expect(effortRule('gpt-5-pro', 'openai-responses').scheme).toBe('none')
    expect(effortRule('gpt-4o', 'openai-chat').scheme).toBe('none')
  })

  it('常开推理:deepseek-reasoner、r1、qwq、*-thinking', () => {
    for (const id of ['deepseek-reasoner', 'deepseek-r1-distill-qwen-32b', 'deepseek/deepseek-r1', 'qwq-32b', 'kimi-k2-thinking', 'claude-sonnet-4-5-thinking']) {
      expect(effortRule(id, 'openai-chat').scheme, id).toBe('always')
    }
  })

  it('OpenAI 协议下的 Claude 不猜(中转站转不转 reasoning_effort 说不准)', () => {
    expect(effortRule('claude-opus-4-5', 'openai-chat').scheme).toBe('none')
  })

  it('认不出的模型:规则是 none,但探测时按协议给一组通用档位', () => {
    expect(effortRule('mystery-model', 'openai-chat').scheme).toBe('none')
    expect(probeCandidates('mystery-model', 'openai-chat')).toEqual({ scheme: 'openai', levels: ['low', 'medium', 'high'] })
    expect(probeCandidates('mystery-model', 'anthropic')).toEqual({ scheme: 'anthropic-adaptive', levels: ['low', 'medium', 'high'] })
    expect(probeCandidates('gpt-5.1', 'openai-chat').levels).toEqual(['none', 'low', 'medium', 'high'])
  })
})

describe('effortOptions:探测结果 > 能力字段 > 规则表', () => {
  it('探测结果优先:accepted 和 effective 可选,rejected 不可选', () => {
    const e: ModelEntry = {
      id: 'gpt-4o',
      probe: { at: 'x', scheme: 'openai', results: { low: { outcome: 'accepted' }, medium: { outcome: 'rejected' }, high: { outcome: 'effective' } } },
    }
    expect(effortOptions(e, 'openai-chat')).toEqual({ scheme: 'openai', levels: ['low', 'high'] })
  })

  it('探测全是 error 不算数,回落到规则表', () => {
    const e: ModelEntry = { id: 'gpt-5.1', probe: { at: 'x', scheme: 'openai', results: { low: { outcome: 'error' } } } }
    expect(effortOptions(e, 'openai-chat').levels).toEqual(['none', 'low', 'medium', 'high'])
  })

  it('探测时的发参方式与当前协议对不上(协议改过)就作废', () => {
    const e: ModelEntry = { id: 'claude-opus-4-5', probe: { at: 'x', scheme: 'openai', results: { high: { outcome: 'effective' } } } }
    expect(effortOptions(e, 'anthropic').scheme).toBe('anthropic-budget')
  })

  it('能力字段里有 effort 取值时用它(仅 OpenAI 兼容协议)', () => {
    const e: ModelEntry = { id: 'mystery', meta: { efforts: ['high', 'low'] } }
    expect(effortOptions(e, 'openai-chat')).toEqual({ scheme: 'openai', levels: ['low', 'high'] })
    expect(effortOptions(e, 'anthropic').scheme).toBe('none')
  })

  it('没有条目时按模型名查规则表', () => {
    expect(effortOptions(undefined, 'openai-chat', 'o3').levels).toEqual(['low', 'medium', 'high'])
  })
})
describe('validateProviderInput', () => {
  const full = { name: '我的中转', base_url: 'https://relay.x', api_key: 'sk-abcdefgh12345678' }

  it('新建:填默认值,规整 Base URL', () => {
    const r = validateProviderInput(full, false, '****')
    expect(r).toEqual({
      ok: true,
      value: { name: '我的中转', mode: 'relay', protocol: 'openai-chat', base_url: 'https://relay.x/v1', api_key: 'sk-abcdefgh12345678', allow_private: false },
    })
  })

  it('新建:名称、Base URL、Key 缺一不可', () => {
    expect(validateProviderInput({ ...full, name: ' ' }, false, '****').ok).toBe(false)
    expect(validateProviderInput({ ...full, base_url: 'ftp://x' }, false, '****').ok).toBe(false)
    expect(validateProviderInput({ ...full, api_key: '' }, false, '****').ok).toBe(false)
  })

  it('新建:掩码值不能当 Key', () => {
    expect(validateProviderInput({ ...full, api_key: '****5678' }, false, '****').ok).toBe(false)
  })

  it('更新:没给的字段不动;空 Key 或掩码 Key = 不改', () => {
    expect(validateProviderInput({ api_key: '****5678' }, true, '****')).toEqual({ ok: true, value: {} })
    expect(validateProviderInput({ api_key: '' }, true, '****')).toEqual({ ok: true, value: {} })
    expect(validateProviderInput({ allow_private: true }, true, '****')).toEqual({ ok: true, value: { allow_private: true } })
  })

  it('协议、方式只认白名单;Key 不能带空白', () => {
    expect(validateProviderInput({ protocol: 'gemini' }, true, '****').ok).toBe(false)
    expect(validateProviderInput({ mode: 'x' }, true, '****').ok).toBe(false)
    expect(validateProviderInput({ api_key: 'sk abc' }, true, '****').ok).toBe(false)
  })

  it('allow_private 只认 true,其余真值不算', () => {
    const r = validateProviderInput({ allow_private: 'yes' }, true, '****')
    expect(r).toEqual({ ok: true, value: { allow_private: false } })
  })
})
