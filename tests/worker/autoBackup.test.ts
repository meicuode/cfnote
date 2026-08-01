import { SELF, env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { ORIGIN, api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'
import { runAutoBackup, runBackup, listBackups } from '../../worker/backup'
import { BACKUP_KEYS, backupPrefix } from '../../src/lib/backupPlan'

// P14.2 自动备份。这条路径的失败方式全都是**静悄悄**的:不备份不会报错、
// 保留策略删错了也不会报错,等你要恢复的时候才发现。所以每条规则都在真库 + 真 R2 上跑一遍。

/**
 * dropAll 只丢 D1 的表,**R2 是不回滚的**(存储隔离按测试文件,不按 it)。
 * 这一批几乎每条断言都是「桶里正好有几份」,不清桶的话第二个用例起就全是脏数据。
 */
async function clearBucket(): Promise<void> {
  const keys: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.BUCKET.list({ cursor, limit: 500 })
    for (const o of page.objects) keys.push(o.key)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  for (let i = 0; i < keys.length; i += 100) await env.BUCKET.delete(keys.slice(i, i + 100))
}

beforeEach(async () => {
  await dropAll()
  await clearBucket()
})

const T0 = Date.parse('2026-07-31T03:47:12Z')
const HOUR = 3600_000

async function setSetting(token: string, kv: Record<string, string>) {
  const r = await api('/api/settings', { method: 'PUT', token, body: j(kv) })
  expect(r.body.ok, r.body.error).toBe(true)
}

const settingOf = async (key: string) =>
  (await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first<{ value: string }>())?.value ?? null

/** 造一个「有东西可备」的库 */
async function seed(): Promise<string> {
  const token = await bootstrap()
  const nb = await newNotebook(token, '技术')
  await newArticle(token, nb, '一篇笔记', '正文内容 ABC')
  return token
}

describe('备份内容与命名', () => {
  it('写进 R2 的是一份能读的完整快照', async () => {
    await seed()
    const r = await runBackup(env, T0)
    expect(r.files).toBe(1)
    expect(r.bytes).toBeGreaterThan(0)

    const obj = await env.BUCKET.get('backups/u1/cfnote-2026-07-31-034712.json')
    expect(obj, '备份对象没写进 R2').toBeTruthy()
    const data = JSON.parse(await obj!.text())
    expect(data.app).toBe('cfnote')
    expect(data.notebooks).toHaveLength(1)
    expect(data.articles[0].content).toContain('正文内容 ABC')
    // 手动导出与自动备份共用同一份构建逻辑,所以敏感设置同样不进备份
    expect(JSON.stringify(data.settings)).not.toContain('llm_api_key')
  })

  it('凭据类设置不进备份', async () => {
    const token = await seed()
    await setSetting(token, { llm_api_key: 'super-secret-key', blog_title: '我的博客' })
    await runBackup(env, T0)
    const data = JSON.parse(await (await env.BUCKET.get(`${backupPrefix(1)}cfnote-2026-07-31-034712.json`))!.text())
    expect(data.settings.blog_title).toBe('我的博客')
    expect(JSON.stringify(data)).not.toContain('super-secret-key')
  })

  it('记下上次备份的时间与大小(设置面板要显示,算错了就是在骗自己)', async () => {
    await seed()
    const r = await runBackup(env, T0)
    expect(await settingOf(BACKUP_KEYS.lastAt)).toBe(new Date(T0).toISOString())
    // 字节数按 UTF-8 算:中文正文用 .length 会少算一半以上
    expect(Number(await settingOf(BACKUP_KEYS.lastSize))).toBe(r.bytes)
    const obj = await env.BUCKET.get(`${backupPrefix(1)}cfnote-2026-07-31-034712.json`)
    expect(obj!.size).toBe(r.bytes)
  })
})

describe('cron 到期闸门', () => {
  it('关闭时一次也不备', async () => {
    const token = await seed()
    await setSetting(token, { [BACKUP_KEYS.interval]: 'off' })
    expect((await runAutoBackup(env, T0)).reason).toBe('off')
    expect(await listBackups(env, 1)).toHaveLength(0)
  })

  it('第一次就备(没有记录 = 到期),之后按周期等', async () => {
    const token = await seed()
    await setSetting(token, { [BACKUP_KEYS.interval]: '5h' })

    expect((await runAutoBackup(env, T0)).ran).toBe(true)
    // 紧接着再被 cron 唤醒:不该再备一份
    expect((await runAutoBackup(env, T0 + 60_000)).reason).toBe('not-due')
    expect((await runAutoBackup(env, T0 + 4 * HOUR)).reason).toBe('not-due')
    expect(await listBackups(env, 1)).toHaveLength(1)

    // 到点了
    expect((await runAutoBackup(env, T0 + 5 * HOUR)).ran).toBe(true)
    expect(await listBackups(env, 1)).toHaveLength(2)
  })

  it('把 7 天改成 5 小时后,不必再等 7 天', async () => {
    const token = await seed()
    await setSetting(token, { [BACKUP_KEYS.interval]: '7d' })
    expect((await runAutoBackup(env, T0)).ran).toBe(true)

    await setSetting(token, { [BACKUP_KEYS.interval]: '5h' })
    // 锚点还是 T0,换了周期到期时间就跟着变——不必为改设置写任何特判
    expect((await runAutoBackup(env, T0 + 4 * HOUR)).reason).toBe('not-due')
    expect((await runAutoBackup(env, T0 + 5 * HOUR)).ran).toBe(true)
  })

  it('备份失败不会变成每 5 分钟重试一次(锚点开工前就推走了)', async () => {
    const token = await seed()
    await setSetting(token, { [BACKUP_KEYS.interval]: '1d' })
    // 造一个合成故障:丢掉 conversations(先丢引用它的 messages,免得外键挡住),
    // 快照构建里那条查询没有 catch,会整个抛出来
    await env.DB.prepare('DROP TABLE IF EXISTS messages').run()
    await env.DB.prepare('DROP TABLE IF EXISTS conversations').run()
    expect((await runAutoBackup(env, T0)).reason).toBe('error')
    expect(await settingOf(BACKUP_KEYS.lastError)).toBeTruthy()
    // 下一次仍是一整个周期之后,不是 5 分钟后
    expect((await runAutoBackup(env, T0 + 5 * 60_000)).reason).toBe('not-due')
    expect((await runAutoBackup(env, T0 + 23 * HOUR)).reason).toBe('not-due')
  })

  it('一个用户都没有时不记账(免得设置里显示「上次备份 0 B」)', async () => {
    await api('/api/init', { method: 'POST' })
    expect((await runAutoBackup(env, T0)).reason).toBe('no-user')
    expect(await settingOf(BACKUP_KEYS.lastAt)).toBeNull()
  })
})

describe('保留份数', () => {
  it('超出就删最旧的,留最新的 N 份', async () => {
    const token = await seed()
    await setSetting(token, { [BACKUP_KEYS.keep]: '2' })

    await runBackup(env, T0)
    await runBackup(env, T0 + HOUR)
    const third = await runBackup(env, T0 + 2 * HOUR)
    expect(third.pruned).toBe(1)

    const files = await listBackups(env, 1)
    expect(files).toHaveLength(2)
    // 新的在前,被删的是最早那份
    expect(files[0].name).toBe('cfnote-2026-07-31-054712.json')
    expect(files[1].name).toBe('cfnote-2026-07-31-044712.json')
    expect(await env.BUCKET.get('backups/u1/cfnote-2026-07-31-034712.json')).toBeNull()
  })
})

describe('接口', () => {
  it('立即备份 → 列表 → 下载,拿回来的是合法 JSON', async () => {
    const token = await seed()
    const run = await api<{ files: number; bytes: number }>('/api/backups/run', { method: 'POST', token })
    expect(run.body.ok, run.body.error).toBe(true)
    expect(run.body.data!.files).toBe(1)

    const list = await api<{ files: { name: string; size: number }[] }>('/api/backups', { token })
    expect(list.body.data!.files).toHaveLength(1)
    const name = list.body.data!.files[0].name

    const dl = await SELF.fetch(`${ORIGIN}/api/backups/${name}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(dl.status).toBe(200)
    expect(dl.headers.get('content-disposition')).toContain('attachment')
    expect((await dl.json() as any).app).toBe('cfnote')

    const del = await api(`/api/backups/${name}`, { method: 'DELETE', token })
    expect(del.body.ok).toBe(true)
    expect(await listBackups(env, 1)).toHaveLength(0)
  })

  it('匿名一个字节都拿不到', async () => {
    await seed()
    await runBackup(env, T0)
    expect((await api('/api/backups')).status).toBe(401)
    expect((await api('/api/backups/cfnote-2026-07-31-034712.json')).status).toBe(401)
    // 附件那条免登录通道也够不着:备份从不登记进 files 表
    const viaFiles = await SELF.fetch(`${ORIGIN}/api/files/backups/u1/cfnote-2026-07-31-034712.json`)
    expect(viaFiles.status).toBe(404)
  })

  it('文件名过不了校验就是 404,没有跨用户或跨前缀的余地', async () => {
    const token = await seed()
    await runBackup(env, T0)
    for (const bad of ['..%2F..%2Fu2%2Fx.json', 'cfnote-2026-07-31-0347.json', '别的.json']) {
      const r = await api(`/api/backups/${bad}`, { token })
      expect(r.status, `${bad} 竟然可读`).toBe(404)
    }
  })
})

describe('备份不掺进文件管理', () => {
  it('扫描登记不会把备份当成附件', async () => {
    const token = await seed()
    await runBackup(env, T0)

    const scan = await api<{ registered: number }>('/api/fm/scan', { method: 'POST', token })
    expect(scan.body.ok, scan.body.error).toBe(true)

    const files = await api<{ files: any[] }>('/api/fm/files', { token })
    expect(files.body.data!.files).toHaveLength(0)
    const ov = await api<{ stats: { count: number } }>('/api/fm/overview', { token })
    expect(ov.body.data!.stats.count).toBe(0)
    // 而备份本身还在
    expect(await listBackups(env, 1)).toHaveLength(1)
  })
})
