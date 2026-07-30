import { SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { ORIGIN, api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

// 单页(P13.4)的端到端:此前「单页不进文章流」这条不变量分散在 blog.ts 的七处查询里,
// 只有单元测试覆盖不到的 SQL 能证明它。这里用真的 D1 跑一遍。

/** 公开一篇笔记 */
async function publish(token: string, id: number) {
  const res = await api(`/api/articles/${id}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
  expect(res.body.ok, res.body.error).toBe(true)
}

/** 设为单页 / 改回文章 */
async function setPage(token: string, id: number, on: boolean) {
  const res = await api(`/api/articles/${id}`, { method: 'PUT', token, body: j({ is_page: on ? 1 : 0 }) })
  expect(res.body.ok, res.body.error).toBe(true)
}

async function blogPostIds(): Promise<number[]> {
  const res = await api<{ posts: { id: number }[] }>('/api/blog/posts')
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.posts.map((p) => p.id)
}

/** 建两篇公开笔记:一篇普通文章,一篇设为单页 */
async function seed() {
  const token = await bootstrap()
  const nb = await newNotebook(token)
  const postId = await newArticle(token, nb, '普通文章', '这是一篇会进列表的文章')
  const pageId = await newArticle(token, nb, '关于我', '这是一张单页')
  await publish(token, postId)
  await publish(token, pageId)
  await setPage(token, pageId, true)
  return { token, nb, postId, pageId }
}

describe('单页不进文章流', () => {
  beforeEach(dropAll)

  it('列表页排除单页,普通文章仍在', async () => {
    const { postId, pageId } = await seed()
    const ids = await blogPostIds()
    expect(ids).toContain(postId)
    expect(ids).not.toContain(pageId)
  })

  it('详情接口照常返回单页,并带 is_page:true', async () => {
    const { pageId } = await seed()
    const res = await api<{ id: number; is_page: boolean; title: string }>(`/api/blog/posts/${pageId}`)
    expect(res.status).toBe(200)
    expect(res.body.ok, res.body.error).toBe(true)
    expect(res.body.data!.is_page).toBe(true)
    expect(res.body.data!.title).toBe('关于我')
  })

  it('RSS 排除单页,sitemap 收录单页', async () => {
    const { pageId } = await seed()

    const feed = await SELF.fetch(`${ORIGIN}/blog/feed.xml`)
    expect(feed.status).toBe(200)
    const feedXml = await feed.text()
    expect(feedXml).toContain('普通文章')
    expect(feedXml).not.toContain('关于我')

    const sm = await SELF.fetch(`${ORIGIN}/sitemap.xml`)
    expect(sm.status).toBe(200)
    const smXml = await sm.text()
    // 单页该被收录:它能被访问、也该被搜索引擎找到,只是不进「最近更新」那条流
    expect(smXml).toContain(`/blog/${pageId}`)
  })

  it('改回文章后重新出现在列表里(标记是可逆的)', async () => {
    const { token, pageId } = await seed()
    expect(await blogPostIds()).not.toContain(pageId)
    await setPage(token, pageId, false)
    expect(await blogPostIds()).toContain(pageId)
  })

  it('取消公开再公开,单页标记不丢', async () => {
    const { token, pageId } = await seed()
    await api(`/api/articles/${pageId}`, { method: 'PUT', token, body: j({ is_public: 0 }) })
    await api(`/api/articles/${pageId}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
    const res = await api<{ is_page: boolean }>(`/api/blog/posts/${pageId}`)
    expect(res.body.data!.is_page).toBe(true)
  })

  it('只改正文不带 is_page 时,单页标记不被清掉', async () => {
    const { token, pageId } = await seed()
    const res = await api(`/api/articles/${pageId}`, { method: 'PUT', token, body: j({ content: '改过的正文' }) })
    expect(res.body.ok, res.body.error).toBe(true)
    const detail = await api<{ is_page: boolean }>(`/api/blog/posts/${pageId}`)
    expect(detail.body.data!.is_page).toBe(true)
  })

  it('管理端 /api/articles/published 的 kind 过滤', async () => {
    const { token, postId, pageId } = await seed()
    const ids = async (qs = '') => {
      const res = await api<{ id: number; is_page: number }[]>(`/api/articles/published${qs}`, { token })
      expect(res.body.ok, res.body.error).toBe(true)
      return res.body.data!.map((a) => a.id)
    }
    expect(await ids()).toEqual(expect.arrayContaining([postId, pageId]))
    expect(await ids('?kind=page')).toEqual([pageId])
    expect(await ids('?kind=post')).toEqual([postId])
  })

  it('私有笔记与未公开笔记都不出现在博客列表里(单页不改变这条)', async () => {
    const { token, nb } = await seed()
    const draft = await newArticle(token, nb, '草稿', '没公开')
    const priv = await newArticle(token, nb, '私有', '私有内容')
    await api(`/api/articles/${priv}`, { method: 'PUT', token, body: j({ is_private: 1 }) })

    const ids = await blogPostIds()
    expect(ids).not.toContain(draft)
    expect(ids).not.toContain(priv)
  })
})
