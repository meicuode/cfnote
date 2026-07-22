import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  chunkText,
  createJWT,
  verifyJWT,
  hashPassword,
  generateSalt,
  contentHash,
  stripThinkTags,
  isAllowedModel,
  isReasoningModel,
  DEFAULT_MODEL,
  withTimeout,
  trackEvent,
} from '../worker/utils'

afterEach(() => {
  vi.useRealTimers()
})

// ---- chunkText:分块错误会静默劣化向量搜索质量 ----

describe('chunkText', () => {
  it('短文本返回单块并去除首尾空白', () => {
    expect(chunkText('  你好世界  ')).toEqual(['你好世界'])
  })

  it('恰好 500 字返回单块', () => {
    const text = 'a'.repeat(500)
    expect(chunkText(text)).toEqual([text])
  })

  it('501 字分为两块,重叠 100 字', () => {
    const text = 'x'.repeat(400) + 'y'.repeat(101)
    const chunks = chunkText(text)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(500)
    // 步长 400:第二块从 400 处开始,前 100 字与第一块尾部重叠
    expect(chunks[1].slice(0, 100)).toBe(chunks[0].slice(400))
  })

  it('长文本每块不超过 500 字,去掉重叠后可无损还原原文', () => {
    const text = Array.from({ length: 1800 }, (_, i) => String.fromCharCode(0x4e00 + (i % 3000))).join('')
    const chunks = chunkText(text)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500)
    const rebuilt = chunks[0] + chunks.slice(1).map((c) => c.slice(100)).join('')
    expect(rebuilt).toBe(text)
  })
})

// ---- JWT:签发/校验/过期/防篡改 ----

describe('JWT', () => {
  const SECRET = 'test-secret'

  it('签发后可校验,payload 携带 uid 和 7 天有效期', async () => {
    const token = await createJWT({ uid: 1, username: 'admin' }, SECRET)
    const payload = await verifyJWT(token, SECRET)
    expect(payload).not.toBeNull()
    expect(payload!.uid).toBe(1)
    expect(payload!.username).toBe('admin')
    expect((payload!.exp as number) - (payload!.iat as number)).toBe(7 * 24 * 3600)
  })

  it('密钥不对返回 null', async () => {
    const token = await createJWT({ uid: 1 }, SECRET)
    expect(await verifyJWT(token, 'wrong-secret')).toBeNull()
  })

  it('篡改 payload 返回 null', async () => {
    const token = await createJWT({ uid: 1 }, SECRET)
    const [h, , s] = token.split('.')
    const forged = btoa(JSON.stringify({ uid: 999, exp: 9999999999 }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(await verifyJWT(`${h}.${forged}.${s}`, SECRET)).toBeNull()
  })

  it('过期 token 返回 null', async () => {
    const token = await createJWT({ uid: 1 }, SECRET)
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 8 * 24 * 3600 * 1000)
    expect(await verifyJWT(token, SECRET)).toBeNull()
  })

  it('格式非法的 token 返回 null', async () => {
    expect(await verifyJWT('abc', SECRET)).toBeNull()
    expect(await verifyJWT('a.b.c', SECRET)).toBeNull()
  })

  it('未配置密钥时签发直接抛错', async () => {
    await expect(createJWT({ uid: 1 }, '')).rejects.toThrow('JWT_SECRET')
  })
})

// ---- 密码哈希:确定性 + 盐生效 ----

describe('hashPassword / generateSalt', () => {
  it('相同密码和盐得到相同哈希(64 位十六进制)', async () => {
    const h1 = await hashPassword('admin123', 'salt-a')
    const h2 = await hashPassword('admin123', 'salt-a')
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('盐或密码不同则哈希不同', async () => {
    const base = await hashPassword('admin123', 'salt-a')
    expect(await hashPassword('admin123', 'salt-b')).not.toBe(base)
    expect(await hashPassword('admin124', 'salt-a')).not.toBe(base)
  })

  it('generateSalt 返回 32 位十六进制且不重复', () => {
    const s1 = generateSalt()
    const s2 = generateSalt()
    expect(s1).toMatch(/^[0-9a-f]{32}$/)
    expect(s1).not.toBe(s2)
  })
})

// ---- contentHash:决定文章是否重新向量化 ----

describe('contentHash', () => {
  it('符合 SHA-256 标准向量', async () => {
    expect(await contentHash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('内容变化哈希变化', async () => {
    expect(await contentHash('a')).not.toBe(await contentHash('b'))
  })
})

// ---- stripThinkTags:推理模型输出清理 ----

describe('stripThinkTags', () => {
  it('移除单个 think 块并修剪空白', () => {
    expect(stripThinkTags('<think>推理过程</think>\n答案')).toBe('答案')
  })

  it('移除多个 think 块(含多行内容)', () => {
    expect(stripThinkTags('<think>a\nb</think>前<think>c</think>后')).toBe('前后')
  })

  it('无标签时原样返回(仅修剪)', () => {
    expect(stripThinkTags('  普通回答  ')).toBe('普通回答')
  })

  it('缺少开头 <think> 只有结尾 </think> 时丢弃前部(QwQ 常见输出)', () => {
    expect(stripThinkTags('好的,用户问...需要引用[1][2]。</think>正式回答内容')).toBe('正式回答内容')
    expect(stripThinkTags('思考A</think>中间</think>答案')).toBe('答案')
  })
})

// ---- 模型白名单 ----

describe('model helpers', () => {
  it('默认模型在白名单内且不是推理模型', () => {
    expect(isAllowedModel(DEFAULT_MODEL)).toBe(true)
    expect(isReasoningModel(DEFAULT_MODEL)).toBe(false)
  })

  it('DeepSeek R1 是推理模型,未知模型两者皆否', () => {
    expect(isReasoningModel('@cf/deepseek-ai/deepseek-r1-distill-qwen-32b')).toBe(true)
    expect(isAllowedModel('@cf/foo/bar')).toBe(false)
    expect(isReasoningModel('@cf/foo/bar')).toBe(false)
  })
})

// ---- withTimeout:AI 调用超时保护 ----

describe('withTimeout', () => {
  it('按时完成返回原值', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
  })

  it('超时后以带标签的错误拒绝', async () => {
    vi.useFakeTimers()
    const p = withTimeout(new Promise(() => {}), 5000, 'AI embedding')
    const assertion = expect(p).rejects.toThrow('AI embedding 超时 (5000ms)')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })
})

// ---- trackEvent:AE 埋点数据结构 ----

describe('trackEvent', () => {
  it('写入 blobs=[action, model, userId] / doubles=[1] / indexes=[action]', () => {
    const writeDataPoint = vi.fn()
    trackEvent({ ANALYTICS: { writeDataPoint } } as any, 'ai_chat', 42, '@cf/qwen/qwq-32b')
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['ai_chat', '@cf/qwen/qwq-32b', '42'],
      doubles: [1],
      indexes: ['ai_chat'],
    })
  })

  it('缺省 model 记为空串;无 ANALYTICS 绑定时静默跳过', () => {
    const writeDataPoint = vi.fn()
    trackEvent({ ANALYTICS: { writeDataPoint } } as any, 'search', 1)
    expect(writeDataPoint).toHaveBeenCalledWith({
      blobs: ['search', '', '1'],
      doubles: [1],
      indexes: ['search'],
    })
    expect(() => trackEvent({} as any, 'search', 1)).not.toThrow()
  })
})
