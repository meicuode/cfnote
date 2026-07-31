import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

// P14.1 回收站语义的端到端断言。这一批全是**不可逆**的路径,而且此前删笔记本
// 是硬删 + 外键 CASCADE + 立即清 R2 —— 一次误点就没了。这类代码只能靠真库跑过才敢说是对的。

beforeEach(dropAll)

/** 直接往 R2 与 files 表塞一个附件,并挂到某篇笔记上(绕开上传接口,只关心引用计数) */
async function attach(
  userId: number, articleId: number, key: string, opts: { folderId?: number | null; size?: number } = {},
): Promise<void> {
  await env.BUCKET.put(key, 'x')
  await env.DB.prepare(
    'INSERT INTO files (user_id, key, name, folder_id, size, category) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(userId, key, key.split('/').pop() || key, opts.folderId ?? null, opts.size ?? 100, 'image').run()
  await env.DB.prepare('INSERT INTO article_files (article_id, file_key) VALUES (?, ?)')
    .bind(articleId, key).run()
}

const r2Has = async (key: string) => !!(await env.BUCKET.get(key))
const liveNotebooks = async (token: string) =>
  (await api<any[]>('/api/notebooks', { token })).body.data || []
const trashNotebooks = async (token: string) =>
  (await api<any[]>('/api/notebooks/trash', { token })).body.data || []
const trashArticles = async (token: string) =>
  (await api<any[]>('/api/articles/trash', { token })).body.data || []

describe('删除笔记本 = 移入回收站(P14.1)', () => {
  it('笔记本与其笔记一起进回收站,附件一个都不动', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '待删本')
    const a1 = await newArticle(token, nb, '甲')
    const a2 = await newArticle(token, nb, '乙')
    await attach(1, a1, 'u1/aaa/图.png')

    const del = await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })
    expect(del.body.ok, del.body.error).toBe(true)
    expect((del.body.data as any).articles).toBe(2)

    // 笔记本从侧栏消失,但行还在(所以 CASCADE 永远不会触发)
    expect(await liveNotebooks(token)).toHaveLength(0)
    const row = await env.DB.prepare('SELECT deleted_at FROM notebooks WHERE id = ?').bind(nb).first<any>()
    expect(row?.deleted_at).toBeTruthy()

    // 两篇笔记都在回收站里
    const trashed = await trashArticles(token)
    expect(trashed.map((a: any) => a.id).sort()).toEqual([a1, a2].sort())

    // 这是这一批的核心:R2 上的文件必须还在
    expect(await r2Has('u1/aaa/图.png')).toBe(true)
    const af = await env.DB.prepare('SELECT COUNT(*) AS c FROM article_files WHERE article_id = ?')
      .bind(a1).first<{ c: number }>()
    expect(af?.c).toBe(1)
  })

  it('不重置此前单独删掉的那几篇的 30 天倒计时', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const old = await newArticle(token, nb, '早就删了的')
    await newArticle(token, nb, '还活着的')
    await api(`/api/articles/${old}`, { method: 'DELETE', token })
    // 把它的删除时间倒推 20 天
    await env.DB.prepare("UPDATE articles SET deleted_at = datetime('now', '-20 days') WHERE id = ?")
      .bind(old).run()

    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })

    const row = await env.DB.prepare('SELECT deleted_at FROM articles WHERE id = ?').bind(old).first<any>()
    // 仍是 20 天前那个时间戳,而不是被刷成现在
    expect(String(row.deleted_at) < new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10)).toBe(true)
  })

  it('回收站里的笔记本不出现在列表里,也不能改名或往里建笔记', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })

    expect((await api(`/api/notebooks/${nb}`, { method: 'PUT', token, body: j({ name: '改名' }) })).body.ok).toBe(false)
    expect((await api('/api/articles', { method: 'POST', token, body: j({ notebook_id: nb, title: 'x', content: 'y' }) })).body.ok).toBe(false)
    expect((await api(`/api/notebooks/${nb}/articles`, { token })).body.ok).toBe(false)
  })
})

describe('恢复(P14.1)', () => {
  it('整本恢复,连带把里面仍在回收站的笔记都带回来', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '待删本')
    await newArticle(token, nb, '甲')
    await newArticle(token, nb, '乙')
    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })

    const list = await trashNotebooks(token)
    expect(list).toHaveLength(1)
    expect(list[0].article_count).toBe(2)

    const res = await api(`/api/notebooks/${nb}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect((res.body.data as any).articles).toBe(2)

    expect(await liveNotebooks(token)).toHaveLength(1)
    expect(await trashArticles(token)).toHaveLength(0)
    const arts = await api<any[]>(`/api/notebooks/${nb}/articles`, { token })
    expect(arts.body.data).toHaveLength(2)
  })

  it('恢复单篇时,若原笔记本也在回收站里则连带把它恢复出来', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '原本')
    const a = await newArticle(token, nb, '甲')
    await newArticle(token, nb, '乙')
    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })

    const res = await api(`/api/articles/${a}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect((res.body.data as any).restored_notebook).toBe('原本')
    // 笔记回到了原来那本,而不是被扔进别的笔记本
    expect((res.body.data as any).notebook_id).toBe(nb)
    expect(await liveNotebooks(token)).toHaveLength(1)
    // 另一篇仍留在回收站(只恢复了点的那一篇)
    expect(await trashArticles(token)).toHaveLength(1)
    // 笔记本已不在回收站列表里
    expect(await trashNotebooks(token)).toHaveLength(0)
  })
})

describe('彻底删除时的附件三档判定(P14.1)', () => {
  it('唯一引用才清:被别的活笔记引用的留下', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const doomed = await newArticle(token, nb, '要删的')
    const alive = await newArticle(token, nb, '留着的')
    await attach(1, doomed, 'u1/solo/独占.png')
    // 同一个 key 被两篇引用
    await attach(1, doomed, 'u1/shared/共用.png')
    await env.DB.prepare('INSERT INTO article_files (article_id, file_key) VALUES (?, ?)')
      .bind(alive, 'u1/shared/共用.png').run()

    await api(`/api/articles/${doomed}`, { method: 'DELETE', token })
    await api(`/api/articles/${doomed}/purge`, { method: 'DELETE', token })

    expect(await r2Has('u1/solo/独占.png')).toBe(false)
    expect(await r2Has('u1/shared/共用.png')).toBe(true)
  })

  it('已归入文件夹的文件不随笔记清理(它是你主动收藏的资产)', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const a = await newArticle(token, nb, '要删的')
    const folder = await api<{ id: number }>('/api/fm/folders', { method: 'POST', token, body: j({ name: '资料' }) })
    await attach(1, a, 'u1/kept/归档.png', { folderId: folder.body.data!.id })

    await api(`/api/articles/${a}`, { method: 'DELETE', token })
    await api(`/api/articles/${a}/purge`, { method: 'DELETE', token })

    expect(await r2Has('u1/kept/归档.png')).toBe(true)
    // files 登记也留着,它会落到「未引用」视图里等人处置
    const f = await env.DB.prepare('SELECT id FROM files WHERE key = ?').bind('u1/kept/归档.png').first()
    expect(f).toBeTruthy()
  })

  it('回收站里的笔记算活着的引用:它引用的附件不会被别人的清理带走', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const inTrash = await newArticle(token, nb, '在回收站里的')
    const purged = await newArticle(token, nb, '被彻底删的')
    await attach(1, inTrash, 'u1/t/回收站引用.png')
    await env.DB.prepare('INSERT INTO article_files (article_id, file_key) VALUES (?, ?)')
      .bind(purged, 'u1/t/回收站引用.png').run()

    await api(`/api/articles/${inTrash}`, { method: 'DELETE', token })
    await api(`/api/articles/${purged}`, { method: 'DELETE', token })
    await api(`/api/articles/${purged}/purge`, { method: 'DELETE', token })

    // inTrash 还在回收站里、还可能被恢复,所以文件必须留着
    expect(await r2Has('u1/t/回收站引用.png')).toBe(true)
  })

  it('彻底删除笔记本走的是同一套判定', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const a = await newArticle(token, nb, '甲')
    await attach(1, a, 'u1/nb/随本删.png')
    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })
    expect(await r2Has('u1/nb/随本删.png')).toBe(true) // 软删阶段不动

    const res = await api(`/api/notebooks/${nb}/purge`, { method: 'DELETE', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(await r2Has('u1/nb/随本删.png')).toBe(false)
    const left = await env.DB.prepare('SELECT COUNT(*) AS c FROM notebooks WHERE id = ?').bind(nb).first<{ c: number }>()
    expect(left?.c).toBe(0)
  })
})

describe('清空回收站与 30 天清理(P14.1)', () => {
  it('预检算出的附件数与真正清掉的一致', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const a = await newArticle(token, nb, '甲')
    const b = await newArticle(token, nb, '乙')
    await attach(1, a, 'u1/x/会删.png', { size: 1024 })
    const folder = await api<{ id: number }>('/api/fm/folders', { method: 'POST', token, body: j({ name: '资料' }) })
    await attach(1, b, 'u1/y/不删.png', { folderId: folder.body.data!.id, size: 2048 })
    await api(`/api/articles/${a}`, { method: 'DELETE', token })
    await api(`/api/articles/${b}`, { method: 'DELETE', token })

    const impact = await api<{ articles: number; files: number; bytes: number }>('/api/articles/trash/impact', { token })
    expect(impact.body.ok, impact.body.error).toBe(true)
    expect(impact.body.data!.articles).toBe(2)
    expect(impact.body.data!.files).toBe(1)
    expect(impact.body.data!.bytes).toBe(1024)

    await api('/api/articles/trash/empty', { method: 'POST', token })
    expect(await r2Has('u1/x/会删.png')).toBe(false)
    expect(await r2Has('u1/y/不删.png')).toBe(true)
  })

  it('清空回收站把里面的笔记本也一并清掉', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    await newArticle(token, nb, '甲')
    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })

    const res = await api<{ purged: number; notebooks: number }>('/api/articles/trash/empty', { method: 'POST', token })
    expect(res.body.data!.purged).toBe(1)
    expect(res.body.data!.notebooks).toBe(1)
    expect(await trashNotebooks(token)).toHaveLength(0)
  })

  it('30 天到期:笔记与笔记本一起清,未到期的一律不动', async () => {
    const token = await bootstrap()
    const oldNb = await newNotebook(token, '超期本')
    await newArticle(token, oldNb, '超期笔记')
    const freshNb = await newNotebook(token, '刚删的本')
    await newArticle(token, freshNb, '刚删的笔记')
    await api(`/api/notebooks/${oldNb}`, { method: 'DELETE', token })
    await api(`/api/notebooks/${freshNb}`, { method: 'DELETE', token })
    await env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now', '-40 days') WHERE id = ?").bind(oldNb).run()
    await env.DB.prepare("UPDATE articles SET deleted_at = datetime('now', '-40 days') WHERE notebook_id = ?").bind(oldNb).run()

    // 打开回收站会懒执行清理
    await api('/api/articles/trash', { token })

    expect(await env.DB.prepare('SELECT COUNT(*) AS c FROM notebooks WHERE id = ?').bind(oldNb).first<{ c: number }>())
      .toMatchObject({ c: 0 })
    expect(await env.DB.prepare('SELECT COUNT(*) AS c FROM notebooks WHERE id = ?').bind(freshNb).first<{ c: number }>())
      .toMatchObject({ c: 1 })
    expect(await trashArticles(token)).toHaveLength(1)
  })

  it('已被恢复的笔记本不会被超期清理误伤', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    await newArticle(token, nb, '甲')
    await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })
    // 笔记本删除时间倒推 40 天,但随后被恢复(deleted_at 清空)
    await env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now', '-40 days') WHERE id = ?").bind(nb).run()
    await api(`/api/notebooks/${nb}/restore`, { method: 'POST', token })

    await api('/api/articles/trash', { token })
    expect(await liveNotebooks(token)).toHaveLength(1)
  })
})

describe('引用清单包含回收站里的笔记(P14.1)', () => {
  it('ref_count 与引用清单口径一致,回收站项带 deleted_at', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const a = await newArticle(token, nb, '被删的笔记')
    await attach(1, a, 'u1/r/只被回收站引用.png')
    await api(`/api/articles/${a}`, { method: 'DELETE', token })

    const fileRow = await env.DB.prepare('SELECT id FROM files WHERE key = ?')
      .bind('u1/r/只被回收站引用.png').first<{ id: number }>()
    const list = await api<{ files: any[] }>('/api/fm/files?view=all', { token })
    const f = list.body.data!.files.find((x) => x.id === fileRow!.id)
    expect(f.ref_count).toBe(1)

    const refs = await api<{ refs: any[] }>(`/api/fm/files/${fileRow!.id}/refs`, { token })
    // 改造前这里是空数组:计数说有 1 篇引用,点开却说没有引用
    expect(refs.body.data!.refs).toHaveLength(1)
    expect(refs.body.data!.refs[0].deleted_at).toBeTruthy()
    expect(refs.body.data!.refs[0].title).toBe('被删的笔记')
  })
})
