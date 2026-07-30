import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, dropAll } from './_helpers'

// 全新初始化路径(P13.6)。此前这条路径完全没有测试:schema 是否正确、
// /api/init 能不能重复执行、migrate 会不会在全新库上撞车,全靠读代码确认。
//
// 注意 pool-workers 的两条前提,本文件的写法依赖它们:
//  1. isolatedStorage 默认开启 —— 每个 it 结束后 D1/R2 回滚,所以每个用例都是空库;
//  2. 每个测试**文件**跑在各自的 worker 实例里 —— 所以 migrate.ts 里 ensureSchema 的
//     模块级 memo(`ensured`)不会跨文件泄漏。ensureSchema 的直接调用因此只在本文件里做。

async function columnsOf(table: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  return new Set((results || []).map((r) => r.name))
}

async function tableNames(): Promise<Set<string>> {
  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all<{ name: string }>()
  return new Set((results || []).map((r) => r.name))
}

describe('全新初始化', () => {
  // 存储隔离只到文件级(见 _helpers.dropAll),所以每个用例自己先把库清空——
  // 「未初始化时怎么样」这类断言必须从「连表都没有」开始才算数
  beforeEach(dropAll)

  it('未初始化时 /api/status 报 initialized:false 而不是 500', async () => {
    const res = await api<{ initialized: boolean; hasUser: boolean }>('/api/status')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.data!.initialized).toBe(false)
  })

  it('/api/init 建出全部表,且 articles 直接带 is_page(P13.4)', async () => {
    const init = await api('/api/init', { method: 'POST' })
    expect(init.body.ok, init.body.error).toBe(true)

    const tables = await tableNames()
    for (const t of ['users', 'notebooks', 'articles', 'files', 'folders', 'article_files', 'comments', 'article_versions', 'settings']) {
      expect(tables.has(t), `缺表: ${t}`).toBe(true)
    }

    const cols = await columnsOf('articles')
    // 全新建表必须自带这些列,否则新用户要靠 migrate 补,而 migrate 的失败是被吞掉的
    for (const c of ['is_public', 'is_private', 'is_page', 'published_at', 'views', 'deleted_at', 'tags', 'pinned', 'share_token', 'share_expires_at', 'remind_at', 'reminded_at']) {
      expect(cols.has(c), `articles 缺列: ${c}`).toBe(true)
    }
    const cmt = await columnsOf('comments')
    for (const c of ['ip', 'user_agent', 'ip_hash', 'root_id', 'parent_id', 'status']) {
      expect(cmt.has(c), `comments 缺列: ${c}`).toBe(true)
    }
  })

  it('/api/init 可重复执行(全部 IF NOT EXISTS)', async () => {
    expect((await api('/api/init', { method: 'POST' })).body.ok).toBe(true)
    expect((await api('/api/init', { method: 'POST' })).body.ok).toBe(true)
    expect((await api('/api/init', { method: 'POST' })).body.ok).toBe(true)
  })

  it('全新库上跑 ensureSchema 不撞车(is_page 已存在,不能再 ALTER 一次)', async () => {
    expect((await api('/api/init', { method: 'POST' })).body.ok).toBe(true)
    // 直接调:worker 中间件里的那次是 .catch(() => {}) 吞掉的,吞掉的异常测不出来。
    // 这正是「SCHEMA 里加了列、migrate 里也加了列」时最容易翻车的地方:duplicate column name。
    const { ensureSchema } = await import('../../worker/migrate')
    await expect(ensureSchema(env as any)).resolves.toBeUndefined()
  })

  it('初始化后可注册并登录,且第二个用户被拒(单用户系统)', async () => {
    expect((await api('/api/init', { method: 'POST' })).body.ok).toBe(true)

    const reg = await api('/api/auth/register', { method: 'POST', body: j({ username: 'tester', password: 'test-password' }) })
    expect(reg.body.ok, reg.body.error).toBe(true)

    const again = await api('/api/auth/register', { method: 'POST', body: j({ username: 'other', password: 'test-password' }) })
    expect(again.status).toBe(403)

    const login = await api<{ token: string }>('/api/auth/login', { method: 'POST', body: j({ username: 'tester', password: 'test-password' }) })
    expect(login.body.ok, login.body.error).toBe(true)
    expect(typeof login.body.data!.token).toBe('string')

    const status = await api<{ initialized: boolean; hasUser: boolean }>('/api/status')
    expect(status.body.data!.initialized).toBe(true)
    expect(status.body.data!.hasUser).toBe(true)
  })

  it('未登录访问受保护接口是 401', async () => {
    expect((await api('/api/init', { method: 'POST' })).body.ok).toBe(true)
    const res = await api('/api/notebooks')
    expect(res.status).toBe(401)
  })
})
