import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

// schema 的两份定义必须一致:
//  - worker/routes/system.ts 的 SCHEMA —— 全新库由 POST /api/init 执行它
//  - worker/migrate.ts 的幂等语句 —— 老库靠它补列/补表
// 漏改任何一边都不会立刻报错:漏了 SCHEMA,新用户建出来的表缺列(而 migrate 的失败在
// worker/index.ts 里是 .catch(() => {}) 吞掉的);漏了 migrate,老用户升级后缺列。
// 这里按**文本**比对两份定义,不连库、不起 workerd,几毫秒跑完。
// 局限说清楚:它证明的是两份定义一致,不是 SQLite 能接受这份 DDL——后者由
// tests/worker/init.test.ts 在真 D1 上跑。

const read = (rel: string) => readFileSync(new URL('../' + rel, import.meta.url), 'utf8')

const SYSTEM_TS = read('worker/routes/system.ts')
const MIGRATE_TS = read('worker/migrate.ts')

/** 从源码里取出 CREATE TABLE IF NOT EXISTS <name> ( ... ) 的括号内文本 */
function createTableBody(src: string, table: string): string {
  const m = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(([\\s\\S]*?)\\n\\s*\\)`, 'i').exec(src)
  expect(m, `源码里找不到 CREATE TABLE ${table}`).not.toBeNull()
  return m![1]
}

/** 列名 = 每行第一个标识符(跳过 FOREIGN KEY / PRIMARY KEY 这类表级约束) */
function columnsOf(body: string): Set<string> {
  const cols = new Set<string>()
  for (const line of body.split('\n')) {
    const m = /^\s*([a-z_][a-z0-9_]*)\s+/i.exec(line)
    if (!m) continue
    const name = m[1].toUpperCase()
    if (name === 'FOREIGN' || name === 'PRIMARY' || name === 'UNIQUE' || name === 'CHECK') continue
    cols.add(m[1])
  }
  return cols
}

/** migrate.ts 里所有 ALTER TABLE <table> ADD COLUMN <col> 的列名 */
function addedColumns(table: string): string[] {
  const re = new RegExp(`ALTER TABLE ${table} ADD COLUMN ([a-z_][a-z0-9_]*)`, 'gi')
  return [...MIGRATE_TS.matchAll(re)].map((m) => m[1])
}

function createdTables(src: string): string[] {
  return [...src.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_][a-z0-9_]*)/gi)].map((m) => m[1])
}

describe('SCHEMA 与 migrate 的一致性', () => {
  it('migrate 给 articles 补的每一列,全新建表里都有', () => {
    const fresh = columnsOf(createTableBody(SYSTEM_TS, 'articles'))
    const added = addedColumns('articles')
    expect(added.length).toBeGreaterThan(5) // 正则没匹配到东西时别假装通过
    for (const col of added) {
      expect(fresh.has(col), `SCHEMA 的 articles 缺列 ${col}(migrate 里加了,全新库不会有)`).toBe(true)
    }
  })

  it('migrate 给 comments 补的每一列,全新建表里都有', () => {
    const fresh = columnsOf(createTableBody(SYSTEM_TS, 'comments'))
    const added = addedColumns('comments')
    expect(added.length).toBeGreaterThan(0)
    for (const col of added) {
      expect(fresh.has(col), `SCHEMA 的 comments 缺列 ${col}`).toBe(true)
    }
  })

  it('migrate 给 files / folders 补的列,全新建表里都有', () => {
    for (const table of ['files', 'folders']) {
      const fresh = columnsOf(createTableBody(SYSTEM_TS, table))
      for (const col of addedColumns(table)) {
        expect(fresh.has(col), `SCHEMA 的 ${table} 缺列 ${col}`).toBe(true)
      }
    }
  })

  it('migrate 幂等补建的每张表,SCHEMA 里也建', () => {
    const fresh = new Set(createdTables(SYSTEM_TS))
    const inMigrate = createdTables(MIGRATE_TS)
    expect(inMigrate.length).toBeGreaterThan(3)
    for (const t of inMigrate) {
      expect(fresh.has(t), `SCHEMA 里没有 ${t}(老库靠 migrate 补建,新库就没有这张表)`).toBe(true)
    }
  })

  it('is_page 两边都在(P13.4 的回归锁)', () => {
    expect(columnsOf(createTableBody(SYSTEM_TS, 'articles')).has('is_page')).toBe(true)
    expect(addedColumns('articles')).toContain('is_page')
  })
})
