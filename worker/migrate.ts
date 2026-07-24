import type { Env } from '../src/types'

// 应用内幂等列迁移(cfnote 部署原则:不依赖本地 CLI,schema 变更随代码自动生效)。
// 线上已有真实数据,新增列不能重建表:每个 isolate 首个 API 请求做一次 PRAGMA 检查,
// 缺哪列补哪列(ALTER TABLE ADD COLUMN),之后 memoize 零开销;失败(如表尚未初始化)下次请求重试。
const ARTICLE_COLUMNS: Record<string, string> = {
  is_public: 'ALTER TABLE articles ADD COLUMN is_public INTEGER DEFAULT 0',
  is_private: 'ALTER TABLE articles ADD COLUMN is_private INTEGER DEFAULT 0',
  published_at: 'ALTER TABLE articles ADD COLUMN published_at TEXT',
  views: 'ALTER TABLE articles ADD COLUMN views INTEGER DEFAULT 0',
}

let ensured: Promise<void> | null = null

export function ensureSchema(env: Env): Promise<void> {
  if (!ensured) {
    ensured = doEnsure(env).catch((e) => {
      ensured = null
      throw e
    })
  }
  return ensured
}

async function doEnsure(env: Env): Promise<void> {
  const { results } = await env.DB.prepare('PRAGMA table_info(articles)').all<{ name: string }>()
  const names = new Set((results || []).map((r) => r.name))
  if (names.size === 0) throw new Error('articles 表尚未创建(待 /api/init 初始化)')
  for (const [col, sql] of Object.entries(ARTICLE_COLUMNS)) {
    if (!names.has(col)) await env.DB.prepare(sql).run()
  }
}
