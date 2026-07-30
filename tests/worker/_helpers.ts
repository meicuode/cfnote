import { SELF, env } from 'cloudflare:test'
import { expect } from 'vitest'

// Worker e2e 的公用夹具。本文件不匹配 include 的 *.test.ts,不会被当成用例收集。

export const ORIGIN = 'https://cfnote.test'

export interface ApiRes<T = any> {
  ok: boolean
  data?: T
  error?: string
}

/** 打一次 API:自动带 JSON 头与 Bearer,永远返回解析后的 body(非 JSON 也不抛,便于断言里看清楚返回了什么) */
export async function api<T = any>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: ApiRes<T>; raw: string }> {
  const { token, headers, ...rest } = init as RequestInit & { token?: string }
  const h = new Headers(headers as HeadersInit | undefined)
  if (token) h.set('Authorization', `Bearer ${token}`)
  if (rest.body && !h.has('Content-Type')) h.set('Content-Type', 'application/json')
  const res = await SELF.fetch(ORIGIN + path, { ...rest, headers: h })
  const raw = await res.text()
  let body: ApiRes<T>
  try {
    body = JSON.parse(raw)
  } catch {
    body = { ok: false, error: `非 JSON 响应(${res.status}): ` + raw.slice(0, 200) }
  }
  return { status: res.status, body, raw }
}

export function j(v: unknown): string {
  return JSON.stringify(v)
}

/**
 * 清空整个库(丢掉所有表),让下一个用例从「连表都没有」开始。
 *
 * vitest-pool-workers 0.19 的存储隔离是**按测试文件**的,不按 it 回滚 ——
 * 不清的话第二个用例注册时会撞上「系统已有用户,不允许再次注册」。
 * 用 beforeEach(dropAll) 而不是共用一份夹具数据,是因为好几条断言要求
 * 「列表里**只有**这一篇」,共用状态就只能退化成 contains,那种断言抓不住多算一篇的 bug。
 *
 * 为什么是多轮重试而不是一遍循环:D1 的 foreign_keys 常开且不允许 PRAGMA 关掉,
 * 先丢父表(users)再丢带 REFERENCES users(id) 的子表会报 "no such table: main.users"。
 * 与其在这里硬编码一份依赖顺序(加一张表就要记得改),不如失败的留到下一轮 ——
 * 子表先成功,父表下一轮自然就能丢。
 */
export async function dropAll(): Promise<void> {
  const list = async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    ).all<{ name: string }>()
    return (results || []).map((r) => r.name)
  }

  let remaining = await list()
  for (let pass = 0; pass < 10 && remaining.length > 0; pass++) {
    const failed: string[] = []
    for (const name of remaining) {
      try {
        await env.DB.prepare(`DROP TABLE IF EXISTS "${name}"`).run()
      } catch {
        failed.push(name)
      }
    }
    // 一轮下来一张都没丢掉:再试也是同样结果,别死循环
    if (failed.length === remaining.length) break
    remaining = failed
  }
}

/**
 * 建库 + 建号 + 登录,返回 token。
 * isolatedStorage 让每个 it 都从空库开始,所以每个用例都要自己走一遍这三步——
 * 这不是浪费,它顺带把「全新初始化能不能用」变成了每个用例的前置断言。
 */
export async function bootstrap(username = 'tester', password = 'test-password'): Promise<string> {
  const init = await api('/api/init', { method: 'POST' })
  expect(init.body.ok, '初始化失败: ' + init.body.error).toBe(true)

  const reg = await api('/api/auth/register', { method: 'POST', body: j({ username, password }) })
  expect(reg.body.ok, '注册失败: ' + reg.body.error).toBe(true)

  const login = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: j({ username, password }) })
  expect(login.body.ok, '登录失败: ' + login.body.error).toBe(true)
  return login.body.data!.token
}

/** 建一个笔记本,返回 id */
export async function newNotebook(token: string, name = '测试笔记本'): Promise<number> {
  const res = await api<{ id: number }>('/api/notebooks', { method: 'POST', token, body: j({ name }) })
  expect(res.body.ok, '建笔记本失败: ' + res.body.error).toBe(true)
  return res.body.data!.id
}

/** 建一篇笔记,返回 id。没有 AI/Vectorize 绑定,vectorize_error 有值是预期的,不影响落库 */
export async function newArticle(
  token: string, notebookId: number, title: string, content = '正文内容',
): Promise<number> {
  const res = await api<{ id: number }>('/api/articles', {
    method: 'POST', token, body: j({ notebook_id: notebookId, title, content }),
  })
  expect(res.body.ok, '建笔记失败: ' + res.body.error).toBe(true)
  return res.body.data!.id
}
