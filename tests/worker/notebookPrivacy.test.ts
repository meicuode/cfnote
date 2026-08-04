import { describe, it, expect, beforeEach } from 'vitest'
import { env } from 'cloudflare:test'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

// P16.5 私密笔记本的不变式:**私密分支里不存在 is_private = 0 的活笔记**。
//
// 这份文件的存在理由是 P16.5.3 那次审计——不变式当时挂在 PUT /api/notebooks/:id 上,
// 而它只扫 deleted_at IS NULL,于是回收站成了一条绕过路径:
// 删一篇公开笔记 → 把它的笔记本设为私密(扫不到回收站里那篇)→ 恢复 → 非私有笔记落回私密支。
// 这类「某条路径忘了过闸门」的缺陷只有端到端跑真库才抓得住,纯函数单测看不见。

beforeEach(dropAll)

const priv = async (id: number): Promise<{ is_private: number; is_public: number }> =>
  (await env.DB.prepare('SELECT is_private, is_public FROM articles WHERE id = ?').bind(id).first()) as any

const setPrivate = (token: string, nb: number, on = true) =>
  api(`/api/notebooks/${nb}`, { method: 'PUT', token, body: j({ is_private: on ? 1 : 0 }) })

/** 直接改库把文章设为公开:走 PUT /articles/:id 要先过「私有不能公开」的互斥校验 */
const forcePublish = (id: number) =>
  env.DB.prepare("UPDATE articles SET is_public = 1, published_at = datetime('now') WHERE id = ?").bind(id).run()

describe('设为私密笔记本时的强制上锁(P16.5.1)', () => {
  it('整支已有笔记一并转私有,公开状态被取消', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '内部资料')
    const a = await newArticle(token, nb, '薪酬表')
    await forcePublish(a)

    expect((await setPrivate(token, nb)).body.ok).toBe(true)
    expect(await priv(a)).toMatchObject({ is_private: 1, is_public: 0 })
  })

  it('子孙笔记本里的笔记也一并上锁', async () => {
    const token = await bootstrap()
    const root = await newNotebook(token, 'ERP笔记')
    const mid = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '内部资料', parent_id: root }),
    })).body.data!.id
    const leaf = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '薪酬', parent_id: mid }),
    })).body.data!.id
    const deep = await newArticle(token, leaf, '三层深的笔记')

    expect((await setPrivate(token, mid)).body.ok).toBe(true)
    expect((await priv(deep)).is_private).toBe(1)
  })

  it('私密支里新建的笔记自动私有(软继承)', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '内部资料')
    await setPrivate(token, nb)
    const child = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '子本', parent_id: nb }),
    })).body.data!.id

    expect((await priv(await newArticle(token, nb, '直接建的'))).is_private).toBe(1)
    expect((await priv(await newArticle(token, child, '子本里建的'))).is_private).toBe(1)
  })

  it('取消私密不解锁已有笔记(安全方向的默认是「不解密」)', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '内部资料')
    const a = await newArticle(token, nb, '甲')
    await setPrivate(token, nb)
    expect((await priv(a)).is_private).toBe(1)

    expect((await setPrivate(token, nb, false)).body.ok).toBe(true)
    expect((await priv(a)).is_private).toBe(1)
  })

  it('挪进私密分支的笔记本,里面已有的笔记跟着上锁', async () => {
    const token = await bootstrap()
    const secret = await newNotebook(token, '内部资料')
    await setPrivate(token, secret)
    const plain = await newNotebook(token, '普通本')
    const a = await newArticle(token, plain, '原本公开的')
    await forcePublish(a)

    const mv = await api(`/api/notebooks/${plain}`, { method: 'PUT', token, body: j({ parent_id: secret }) })
    expect(mv.body.ok, mv.body.error).toBe(true)
    expect(await priv(a)).toMatchObject({ is_private: 1, is_public: 0 })
  })
})

describe('回收站不能绕过私密不变式(P16.5.3 修的漏)', () => {
  it('单篇恢复:落回私密支就强制上锁', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '内部资料')
    const a = await newArticle(token, nb, '待删的公开笔记')
    await forcePublish(a)

    // 先删掉——软删清 is_public 但**不清 is_private**(刻意如此)
    expect((await api(`/api/articles/${a}`, { method: 'DELETE', token })).body.ok).toBe(true)
    // 此时才设为私密:拉平只扫活笔记,回收站里这篇躲过去了
    expect((await setPrivate(token, nb)).body.ok).toBe(true)
    expect((await priv(a)).is_private).toBe(0) // 确认「躲过去了」这个前提成立

    const res = await api(`/api/articles/${a}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect((await priv(a)).is_private).toBe(1)
  })

  it('整本恢复:连同笔记一起强制上锁', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token, '内部资料')
    const a = await newArticle(token, nb, '甲')
    const b = await newArticle(token, nb, '乙')
    await forcePublish(a)

    expect((await api(`/api/notebooks/${nb}`, { method: 'DELETE', token })).body.ok).toBe(true)
    // 笔记本在回收站里也能设私密(PUT 不要求它活着),这正是最刁的那条路径
    await env.DB.prepare('UPDATE notebooks SET is_private = 1 WHERE id = ?').bind(nb).run()

    const res = await api(`/api/notebooks/${nb}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect((await priv(a)).is_private).toBe(1)
    expect((await priv(b)).is_private).toBe(1)
  })

  it('祖先在回收站里时,私密性照样沿链继承', async () => {
    // loadNotebookRows 刻意连已删的笔记本一起取:漏掉已删的祖先,链就断了,
    // inPrivateBranch 会误判成「不在私密分支」
    const token = await bootstrap()
    const root = await newNotebook(token, '私密根')
    const child = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '子本', parent_id: root }),
    })).body.data!.id
    const a = await newArticle(token, child, '甲')

    await env.DB.prepare('UPDATE notebooks SET is_private = 1 WHERE id = ?').bind(root).run()
    // 父子一起进回收站(P16.1 只挡「有活着的子本时不许删」)
    await api(`/api/notebooks/${child}`, { method: 'DELETE', token })
    await env.DB.prepare("UPDATE notebooks SET deleted_at = datetime('now') WHERE id = ?").bind(root).run()

    const res = await api(`/api/notebooks/${child}/restore`, { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    expect((await priv(a)).is_private).toBe(1)
  })
})

describe('/api/init 的匿名防刷(P16.5.3)', () => {
  it('已初始化后匿名再调只短路,不重跑建表', async () => {
    await bootstrap()
    const again = await api<{ already?: boolean }>('/api/init', { method: 'POST' })
    expect(again.body.ok).toBe(true)
    expect(again.body.data?.already).toBe(true)
  })

  it('登录态仍可重跑(改 SCHEMA 后靠它建新表,这条路不能堵)', async () => {
    const token = await bootstrap()
    const again = await api<{ already?: boolean }>('/api/init', { method: 'POST', token })
    expect(again.body.ok).toBe(true)
    expect(again.body.data?.already).toBeUndefined()
  })
})
