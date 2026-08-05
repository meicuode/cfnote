import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

// 深/浅视图与「我的私有」审计视图(P16.2)的端到端。
//
// 这两个视图的失败方式都是**静默**的:深视图漏掉一支,你只会以为那支是空的;
// 审计视图漏掉一条例外,你会以为整棵锁得好好的——而后者正是这个视图存在的理由。

/** 建一棵 技术 > 前端 > React 的三层树,每层放一篇 */
async function seedTree(token: string) {
  const tech = await newNotebook(token, '技术')
  const fe = (await api<{ id: number }>('/api/notebooks', {
    method: 'POST', token, body: j({ name: '前端', parent_id: tech }),
  })).body.data!.id
  const react = (await api<{ id: number }>('/api/notebooks', {
    method: 'POST', token, body: j({ name: 'React', parent_id: fe }),
  })).body.data!.id
  await newArticle(token, tech, '技术根上的')
  await newArticle(token, fe, '前端里的')
  await newArticle(token, react, 'React 里的')
  return { tech, fe, react }
}

describe('深/浅视图(P16.2)', () => {
  beforeEach(dropAll)

  it('默认浅:只给这一本自己的文章', async () => {
    const token = await bootstrap()
    const { tech } = await seedTree(token)
    const res = await api<any[]>(`/api/notebooks/${tech}/articles`, { token })
    expect(res.body.data!.map((a) => a.title)).toEqual(['技术根上的'])
  })

  it('deep=1:连子孙本的一起给', async () => {
    const token = await bootstrap()
    const { tech } = await seedTree(token)
    const res = await api<any[]>(`/api/notebooks/${tech}/articles?deep=1`, { token })
    expect(new Set(res.body.data!.map((a) => a.title)))
      .toEqual(new Set(['技术根上的', '前端里的', 'React 里的']))
  })

  it('深视图每条都带归属路径,浅视图不带', async () => {
    // 没有路径的深列表就是一堆不知道从哪来的标题——同名笔记尤其分不清
    const token = await bootstrap()
    const { tech } = await seedTree(token)
    const deep = await api<any[]>(`/api/notebooks/${tech}/articles?deep=1`, { token })
    const byTitle = new Map(deep.body.data!.map((a) => [a.title, a.notebook_path]))
    expect(byTitle.get('技术根上的')).toBe('技术')
    expect(byTitle.get('前端里的')).toBe('技术 / 前端')
    expect(byTitle.get('React 里的')).toBe('技术 / 前端 / React')

    const shallow = await api<any[]>(`/api/notebooks/${tech}/articles`, { token })
    expect(shallow.body.data![0].notebook_path).toBeUndefined()
  })

  it('深视图不把回收站里的子本算进来', async () => {
    const token = await bootstrap()
    const { tech, fe } = await seedTree(token)
    await api(`/api/notebooks/${fe}`, { method: 'DELETE', token })
    const res = await api<any[]>(`/api/notebooks/${tech}/articles?deep=1`, { token })
    // 前端 与 React 整支进了回收站,只剩根上那篇
    expect(res.body.data!.map((a) => a.title)).toEqual(['技术根上的'])
  })

  it('别人的笔记本 id 一律 404,不会因为 deep 就漏出去', async () => {
    // 单用户系统里"另一个用户"造不出来(注册接口只允许一次),所以直接拿一个
    // 不存在的 id:深视图的存在性校验走的是 hasLiveNotebook,不能因为加了 deep 就绕过
    const token = await bootstrap()
    await seedTree(token)
    const res = await api(`/api/notebooks/999999/articles?deep=1`, { token })
    expect(res.status).toBe(404)
  })

  it('置顶优先、其次按更新时间倒序——分片查回来的顺序不作数', async () => {
    const token = await bootstrap()
    const { tech, fe } = await seedTree(token)
    const pinned = await newArticle(token, fe, '子本里被置顶的')
    await api(`/api/articles/${pinned}`, { method: 'PUT', token, body: j({ pinned: 1 }) })
    const res = await api<any[]>(`/api/notebooks/${tech}/articles?deep=1`, { token })
    expect(res.body.data![0].title).toBe('子本里被置顶的')
  })
})

describe('「我的私有」审计视图(P16.2)', () => {
  beforeEach(dropAll)

  it('返回 {articles, exceptions} 而不是裸数组', async () => {
    const token = await bootstrap()
    const res = await api<{ articles: any[]; exceptions: any[] }>('/api/articles/private', { token })
    expect(Array.isArray(res.body.data!.articles)).toBe(true)
    expect(Array.isArray(res.body.data!.exceptions)).toBe(true)
  })

  it('每篇私有笔记都带归属路径,并区分继承来的与显式标的', async () => {
    const token = await bootstrap()
    const { fe } = await seedTree(token)
    // 把「前端」设为私密 → 这一支的笔记被拉平上锁(inherited = 1)
    await api(`/api/notebooks/${fe}`, { method: 'PUT', token, body: j({ is_private: 1 }) })
    // 另一本不私密的笔记本里,单独标一篇私有(inherited = 0)
    const misc = await newNotebook(token, '杂项')
    const lone = await newArticle(token, misc, '单独标私有的')
    await api(`/api/articles/${lone}`, { method: 'PUT', token, body: j({ is_private: 1 }) })

    const res = await api<{ articles: any[] }>('/api/articles/private', { token })
    const by = new Map(res.body.data!.articles.map((a) => [a.title, a]))
    expect(by.get('前端里的')!.notebook_path).toBe('技术 / 前端')
    expect(by.get('前端里的')!.inherited).toBe(1)
    expect(by.get('单独标私有的')!.notebook_path).toBe('杂项')
    // 这一条是审计的重点:私有但**不在**私密分支里,取消私密笔记本时它不会跟着变
    expect(by.get('单独标私有的')!.inherited).toBe(0)
  })

  it('正常情况下例外项为空——不变式保证私密分支里没有未上锁的活笔记', async () => {
    const token = await bootstrap()
    const { fe } = await seedTree(token)
    await api(`/api/notebooks/${fe}`, { method: 'PUT', token, body: j({ is_private: 1 }) })
    const res = await api<{ exceptions: any[] }>('/api/articles/private', { token })
    expect(res.body.data!.exceptions).toEqual([])
  })

  it('私密分支里有未上锁的笔记时,必须被列成例外', async () => {
    // 这正是 P16.5.3 修过的那类破口。不变式挂在 PUT /api/notebooks/:id 上,
    // 而任何绕过它的写入都会造出这个状态。这个视图是**唯一**能看见它的地方,
    // 所以这里直接改库造出破口——测的是"看得见",不是"造得出"
    const token = await bootstrap()
    const { fe } = await seedTree(token)
    await api(`/api/notebooks/${fe}`, { method: 'PUT', token, body: j({ is_private: 1 }) })
    await env.DB.prepare("UPDATE articles SET is_private = 0 WHERE title = '前端里的'").run()

    const res = await api<{ exceptions: any[] }>('/api/articles/private', { token })
    expect(res.body.data!.exceptions.map((e) => e.title)).toEqual(['前端里的'])
    expect(res.body.data!.exceptions[0].notebook_path).toBe('技术 / 前端')
  })

  it('例外项要标出哪些还在博客上——那是有外部影响的部分', async () => {
    const token = await bootstrap()
    const { fe } = await seedTree(token)
    const id = (await api<any[]>(`/api/notebooks/${fe}/articles`, { token })).body.data![0].id
    await api(`/api/articles/${id}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
    await api(`/api/notebooks/${fe}`, { method: 'PUT', token, body: j({ is_private: 1 }) })
    // 上锁会把 is_public 清掉,所以要造"还公开着的例外"必须直接改库
    await env.DB.prepare("UPDATE articles SET is_private = 0, is_public = 1 WHERE id = ?").bind(id).run()

    const res = await api<{ exceptions: any[] }>('/api/articles/private', { token })
    expect(res.body.data!.exceptions[0].is_public).toBe(1)
  })

  it('回收站里的笔记不算例外——它已经不在任何地方展示了', async () => {
    const token = await bootstrap()
    const { fe } = await seedTree(token)
    await api(`/api/notebooks/${fe}`, { method: 'PUT', token, body: j({ is_private: 1 }) })
    const id = (await api<{ articles: any[] }>('/api/articles/private', { token }))
      .body.data!.articles.find((a) => a.title === '前端里的')!.id
    await env.DB.prepare('UPDATE articles SET is_private = 0 WHERE id = ?').bind(id).run()
    await api(`/api/articles/${id}`, { method: 'DELETE', token })

    const res = await api<{ exceptions: any[] }>('/api/articles/private', { token })
    expect(res.body.data!.exceptions).toEqual([])
  })
})
