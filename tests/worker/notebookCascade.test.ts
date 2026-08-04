import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

// P16.3 树的删除与恢复语义。
//
// P16.1 当时直接拒绝「删有子本的笔记本」,理由是宁可拦住也不能让回收站里对不上账。
// 这批把拦截换成级联,而级联能不能开,取决于恢复侧接不接得回来——所以这份文件的重点
// 全在恢复:子孙回不回来、祖先链断不断、私密闸门有没有一起过。

beforeEach(dropAll)

const mkChild = async (token: string, name: string, parent: number): Promise<number> => {
  const res = await api<{ id: number }>('/api/notebooks', { method: 'POST', token, body: j({ name, parent_id: parent }) })
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.id
}

const nbRow = (id: number) =>
  env.DB.prepare('SELECT deleted_at, parent_id, article_count FROM notebooks WHERE id = ?').bind(id).first<any>()

const artRow = (id: number) =>
  env.DB.prepare('SELECT deleted_at, is_private, is_public FROM articles WHERE id = ?').bind(id).first<any>()

/** 直接改库把文章设为公开:走 PUT 要先过「私有不能公开」的互斥校验 */
const forcePublish = (id: number) =>
  env.DB.prepare("UPDATE articles SET is_public = 1, published_at = datetime('now') WHERE id = ?").bind(id).run()

describe('删父级联进回收站(P16.3)', () => {
  it('整棵子树连同笔记一起进回收站', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    const leaf = await mkChild(token, '薪酬', mid)
    const a = await newArticle(token, root, '根上的')
    const b = await newArticle(token, leaf, '三层深的')

    const res = await api<{ articles: number; notebooks: number }>(`/api/notebooks/${root}`, { method: 'DELETE', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.notebooks).toBe(3)
    expect(res.body.data!.articles).toBe(2)

    for (const n of [root, mid, leaf]) expect((await nbRow(n)).deleted_at).not.toBeNull()
    for (const x of [a, b]) expect((await artRow(x)).deleted_at).not.toBeNull()
  })

  it('公开的笔记会下线,分享链接失效', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const leaf = await mkChild(token, '子本', root)
    const a = await newArticle(token, leaf, '已发布的')
    await forcePublish(a)

    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })
    expect((await artRow(a)).is_public).toBe(0)
  })

  it('已经在回收站里的子孙不被重置倒计时', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '早删的', root)
    await api(`/api/notebooks/${mid}`, { method: 'DELETE', token })
    await env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now', '-20 days') WHERE id = ?").bind(mid).run()

    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })
    // 20 天前那个时间戳还在:各有各的 30 天
    const row = await nbRow(mid)
    expect(String(row.deleted_at)).not.toContain(new Date().toISOString().slice(0, 10))
  })
})

describe('恢复整棵子树 + 祖先链(P16.3)', () => {
  it('恢复根:子孙与它们的笔记一起回来', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    const leaf = await mkChild(token, '薪酬', mid)
    const a = await newArticle(token, leaf, '三层深的')
    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })

    const res = await api(`/api/notebooks/${root}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    for (const n of [root, mid, leaf]) expect((await nbRow(n)).deleted_at).toBeNull()
    expect((await artRow(a)).deleted_at).toBeNull()
    // 计数重算过了
    expect((await nbRow(leaf)).article_count).toBe(1)
  })

  it('只恢复子本:祖先链跟着回来,但祖先自己的笔记留在回收站', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    const rootArt = await newArticle(token, root, '根上的')
    const midArt = await newArticle(token, mid, '子本里的')
    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })

    const res = await api<{ ancestors: number }>(`/api/notebooks/${mid}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.ancestors).toBe(1)

    // 祖先的壳回来了(否则 mid 的 parent_id 指向回收站里的行,buildTree 会把它兜回根)
    expect((await nbRow(root)).deleted_at).toBeNull()
    expect((await nbRow(mid)).deleted_at).toBeNull()
    // 但祖先自己的笔记没被顺带捞回来——你点的是恢复 mid
    expect((await artRow(rootArt)).deleted_at).not.toBeNull()
    expect((await artRow(midArt)).deleted_at).toBeNull()
    // 祖先的计数因此仍是 0,而不是把回收站里那篇算进去
    expect((await nbRow(root)).article_count).toBe(0)
  })

  it('恢复落回私密支的笔记照样强制上锁(P16.5.3 的闸门在级联路径上也要过)', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, '私密根')
    const leaf = await mkChild(token, '子本', root)
    const a = await newArticle(token, leaf, '公开的')
    await forcePublish(a)
    await api(`/api/notebooks/${root}`, { method: 'PUT', token, body: j({ is_private: 1 }) })
    // 上锁之后再造一篇没锁的:直接改库,模拟「躲过拉平」的那类行
    await env.DB.prepare('UPDATE articles SET is_private = 0, is_public = 1 WHERE id = ?').bind(a).run()

    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })
    expect((await artRow(a)).is_private).toBe(0) // 确认前提:它确实是没锁的
    await api(`/api/notebooks/${root}/restore`, { method: 'POST', token })
    expect((await artRow(a)).is_private).toBe(1)
  })

  it('单篇恢复也补祖先链(这个洞在 P16.3 之前就能踩到)', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    const a = await newArticle(token, mid, '甲')
    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })

    const res = await api(`/api/articles/${a}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect((await nbRow(mid)).deleted_at).toBeNull()
    expect((await nbRow(root)).deleted_at).toBeNull() // 祖先,不是直属本
  })
})

describe('彻底删除不留孤儿(P16.3)', () => {
  it('purge 一本会连它回收站里的子孙一起清掉', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    await newArticle(token, mid, '甲')
    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })

    const res = await api<{ notebooks: number }>(`/api/notebooks/${root}/purge`, { method: 'DELETE', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.notebooks).toBe(2)
    expect(await nbRow(mid)).toBeNull()
    expect(await nbRow(root)).toBeNull()
  })

  it('子本已被恢复时拒绝 purge 父本,而不是悄悄留下孤儿', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })
    // 单独恢复子本(祖先链会把 root 也拉活,所以先把 root 再删回去)
    await api(`/api/notebooks/${mid}/restore`, { method: 'POST', token })
    await env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now') WHERE id = ?").bind(root).run()

    const res = await api(`/api/notebooks/${root}/purge`, { method: 'DELETE', token })
    expect(res.body.ok).toBe(false)
    expect(res.body.error).toContain('已恢复的子笔记本')
    expect(await nbRow(mid)).not.toBeNull()
  })

  it('清空回收站不会清掉活着子本的父亲', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = await mkChild(token, '内部资料', root)
    await api(`/api/notebooks/${root}`, { method: 'DELETE', token })
    await api(`/api/notebooks/${mid}/restore`, { method: 'POST', token })
    await env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now') WHERE id = ?").bind(root).run()

    await api('/api/articles/trash/empty', { method: 'POST', token })
    // root 留着:清掉它就会让活着的 mid 指向空号
    expect(await nbRow(root)).not.toBeNull()
  })
})
