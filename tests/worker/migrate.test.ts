import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { dropAll } from './_helpers'

// 老库升级路径(P13.6)。对应本项目的部署约定:schema 变更一律是幂等增量语句,
// 用户不需要重建数据库。此前这条路径同样零覆盖——「加了列但没生效」在生产上表现为
// 500,而中间件里 ensureSchema 的异常是被 .catch(() => {}) 吞掉的,不会有任何日志。
//
// 本文件只有一个 it:ensureSchema 的 memo 是模块级的(每个 isolate 只真跑一次),
// 而每个测试文件是独立 worker 实例,所以「一个文件一次真实迁移」是这里唯一可靠的写法。

// P8 之前的老表:没有 is_public/is_private/is_page/tags/share_token… 什么都没有
const OLD_ARTICLES = `CREATE TABLE articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notebook_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  is_vectorized INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`

// P14.1 之前的 notebooks:没有 deleted_at
const OLD_NOTEBOOKS = `CREATE TABLE notebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#10B981',
  article_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)`

async function columnsOf(table: string): Promise<Set<string>> {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()
  return new Set((results || []).map((r) => r.name))
}

describe('老库幂等迁移', () => {
  beforeEach(dropAll)

  it('老 articles/notebooks 表补齐全部新列,已有数据不丢且 is_page 默认 0', async () => {
    await env.DB.prepare(OLD_ARTICLES).run()
    await env.DB.prepare(OLD_NOTEBOOKS).run()
    await env.DB.prepare("INSERT INTO notebooks (user_id, name) VALUES (1, '老笔记本')").run()
    await env.DB.prepare(
      "INSERT INTO articles (notebook_id, user_id, title, content) VALUES (1, 1, '老文章', '老正文')",
    ).run()

    const { ensureSchema } = await import('../../worker/migrate')
    await ensureSchema(env as any)

    const cols = await columnsOf('articles')
    for (const c of ['is_public', 'is_private', 'is_page', 'published_at', 'views', 'deleted_at', 'tags', 'pinned', 'share_token', 'share_expires_at', 'remind_at', 'reminded_at']) {
      expect(cols.has(c), `迁移后 articles 仍缺列: ${c}`).toBe(true)
    }

    // P14.1:笔记本软删除列。老库里的笔记本必须补上且**默认为 NULL**(不是 0/空串),
    // 否则全部现存笔记本会被当成「在回收站里」而从侧栏消失
    const nbCols = await columnsOf('notebooks')
    expect(nbCols.has('deleted_at'), '迁移后 notebooks 仍缺 deleted_at').toBe(true)
    const nb = await env.DB.prepare('SELECT name, deleted_at FROM notebooks WHERE id = 1').first<any>()
    expect(nb.name).toBe('老笔记本')
    expect(nb.deleted_at).toBeNull()

    // 老数据必须原样在,且新列取默认值——ADD COLUMN ... DEFAULT 0 会把已有行填成 0 而不是 NULL,
    // 这是「老文章不会突然变成单页」的依据(POST_WHERE 用的是 COALESCE(is_page,0)=0)
    const row = await env.DB.prepare('SELECT title, content, is_page, is_public FROM articles WHERE id = 1').first<any>()
    expect(row.title).toBe('老文章')
    expect(row.content).toBe('老正文')
    expect(row.is_page ?? 0).toBe(0)
    expect(row.is_public ?? 0).toBe(0)

    // 附件三表、版本表、评论表由 migrate 幂等补建(老库里根本没有)
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all<{ name: string }>()
    const tables = new Set((results || []).map((r) => r.name))
    for (const t of ['files', 'folders', 'article_files', 'article_versions', 'comments']) {
      expect(tables.has(t), `迁移后缺表: ${t}`).toBe(true)
    }

    // 评论表的后补列(P11.9)必须在建表之后补上
    const cmt = await columnsOf('comments')
    expect(cmt.has('ip')).toBe(true)
    expect(cmt.has('user_agent')).toBe(true)
  })
})
