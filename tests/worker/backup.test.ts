import { SELF, env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { ORIGIN, api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'

// 备份完整性(P12.11)的端到端。这条路径此前只靠读代码确认,而它的失败方式最难发现:
// 导出的文件看着挺大、导入也报成功,直到你发现所有文章变回未公开、评论全没了。

/** 导出不是 ok() 包装的,是直接下载一份 JSON */
async function exportAll(token: string): Promise<any> {
  const res = await SELF.fetch(`${ORIGIN}/api/export`, { headers: { Authorization: `Bearer ${token}` } })
  expect(res.status).toBe(200)
  expect(res.headers.get('content-disposition')).toContain('attachment')
  return await res.json()
}

/** 造一份「有内容」的库:公开文章 + 单页 + 评论 + 博客配置 + 敏感设置 */
async function seedEverything() {
  const token = await bootstrap()
  const nb = await newNotebook(token, '技术')
  const postId = await newArticle(token, nb, '普通文章', '正文 A')
  const pageId = await newArticle(token, nb, '关于我', '正文 B')
  for (const id of [postId, pageId]) {
    await api(`/api/articles/${id}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
  }
  await api(`/api/articles/${pageId}`, { method: 'PUT', token, body: j({ is_page: 1 }) })

  // 访客评论(默认待审)
  const cmt = await api<{ id: number }>('/api/blog/comments', {
    method: 'POST',
    body: j({ article_id: postId, author_name: '路人', author_email: 'a@b.c', content: '写得不错' }),
  })
  expect(cmt.body.ok, cmt.body.error).toBe(true)

  await api('/api/settings', {
    method: 'PUT', token,
    body: j({
      blog_skin: '{"primary":"#123456"}',
      comments_auto_approve: '1',
      site_url: 'https://old-domain.example',
      llm_api_key: 'super-secret-key',
    }),
  })
  return { token, nb, postId, pageId, commentId: cmt.body.data!.id }
}

describe('备份导出/导入', () => {
  beforeEach(dropAll)

  it('导出带上公开状态、单页标记、浏览数与评论,但不带敏感项', async () => {
    const { token, postId, pageId } = await seedEverything()
    const dump = await exportAll(token)

    expect(dump.app).toBe('cfnote')
    expect(dump.export_version).toBe(2)

    const arts = dump.articles as any[]
    expect(arts).toHaveLength(2)
    const page = arts.find((a) => a.id === pageId)
    const post = arts.find((a) => a.id === postId)
    expect(page.is_page).toBe(1)
    expect(post.is_page).toBe(0)
    expect(post.is_public).toBe(1)
    expect(post.published_at).toBeTruthy()

    expect((dump.comments as any[]).map((c) => c.content)).toEqual(['写得不错'])
    // 完整备份里评论含邮箱与 IP(那条「公开接口不返回」的规矩只管 /api/blog/comments)
    expect((dump.comments as any[])[0].author_email).toBe('a@b.c')

    expect(dump.settings.blog_skin).toBe('{"primary":"#123456"}')
    // 敏感项按键名过滤:一个都不该出现在备份文件里
    expect(dump.settings.llm_api_key).toBeUndefined()
    expect(dump.settings.notify_channels).toBeUndefined()

    // 默认不带历史版本(体积会翻几倍)
    expect(dump.article_versions).toEqual([])
  })

  it('导进一个空库:文章的公开状态与单页标记、评论、博客配置都回来了', async () => {
    const { token } = await seedEverything()
    const dump = await exportAll(token)

    // 换一个全新的库(相当于换台机器恢复备份)
    await dropAll()
    const token2 = await bootstrap('restored', 'test-password')

    const res = await api<{ notebooks: number; articles: number }>('/api/import', {
      method: 'POST', token: token2, body: JSON.stringify(dump),
    })
    expect(res.body.ok, res.body.error).toBe(true)

    // 文章:单页仍是单页,普通文章仍在列表里
    const published = await api<{ id: number; title: string; is_page: number }[]>('/api/articles/published', { token: token2 })
    const titles = published.body.data!.map((a) => a.title).sort()
    expect(titles).toEqual(['关于我', '普通文章'])
    expect(published.body.data!.find((a) => a.title === '关于我')!.is_page).toBe(1)

    const blogIds = await api<{ posts: { title: string }[] }>('/api/blog/posts')
    expect(blogIds.body.data!.posts.map((p) => p.title)).toEqual(['普通文章'])

    // 评论:跟着它所属的文章恢复
    const cmts = await env.DB.prepare('SELECT content, article_id FROM comments').all<{ content: string; article_id: number }>()
    expect((cmts.results || []).map((r) => r.content)).toEqual(['写得不错'])
    const owner = await env.DB.prepare('SELECT title FROM articles WHERE id = ?')
      .bind((cmts.results || [])[0].article_id).first<{ title: string }>()
    expect(owner!.title).toBe('普通文章')

    // 博客配置恢复了,但 site_url 不在白名单(换域名恢复会把 RSS/sitemap 的绝对地址写错)
    const skin = await env.DB.prepare("SELECT value FROM settings WHERE key = 'blog_skin'").first<{ value: string }>()
    expect(skin!.value).toBe('{"primary":"#123456"}')
    const siteUrl = await env.DB.prepare("SELECT value FROM settings WHERE key = 'site_url'").first()
    expect(siteUrl).toBeNull()
  })

  it('笔记本树与私密标志能往返(P16.8:这两列此前根本没进备份)', async () => {
    const token = await bootstrap()
    // 三层树 + 中间一层私密 + 自定义颜色
    const root = await newNotebook(token, 'ERP笔记')
    const mid = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '内部资料', parent_id: root, color: '#FF00AA' }),
    })).body.data!.id
    const leaf = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '薪酬', parent_id: mid }),
    })).body.data!.id
    await newArticle(token, leaf, '三层深的笔记')
    await api(`/api/notebooks/${mid}`, { method: 'PUT', token, body: j({ is_private: 1 }) })

    const dump = await exportAll(token)
    // 先确认导出里真的带上了这两列——不然下面的断言可能是靠同名复用蒙对的
    const dumped = dump.notebooks.find((n: any) => n.name === '内部资料')
    expect(dumped.is_private).toBe(1)
    expect(dump.notebooks.find((n: any) => n.name === '薪酬').parent_id).toBe(dumped.id)

    await dropAll()
    const token2 = await bootstrap('restored', 'test-password')
    const res = await api('/api/import', { method: 'POST', token: token2, body: JSON.stringify(dump) })
    expect(res.body.ok, res.body.error).toBe(true)

    const rows = await env.DB.prepare('SELECT id, name, parent_id, is_private, color FROM notebooks').all<any>()
    const by = new Map((rows.results || []).map((n) => [n.name, n]))
    // 层级回来了
    expect(by.get('内部资料')!.parent_id).toBe(by.get('ERP笔记')!.id)
    expect(by.get('薪酬')!.parent_id).toBe(by.get('内部资料')!.id)
    // 私密标志回来了(丢了的话:老笔记看着还是私有的,但此后新写进这一支的不再自动上锁)
    expect(by.get('内部资料')!.is_private).toBe(1)
    expect(by.get('ERP笔记')!.is_private).toBe(0)
    // 颜色也回来了(备份里一直有,恢复侧此前只写 name)
    expect(by.get('内部资料')!.color).toBe('#FF00AA')
  })

  it('恢复后往私密支里新建笔记,仍然自动上锁', async () => {
    // 上一条验的是「标志位存回来了」,这条验的是**行为**真的跟着回来了。
    // 私密继承是沿祖先链算的,parent_id 若没接上,子本里新建的笔记就不会上锁
    const token = await bootstrap()
    const root = await newNotebook(token, '私密根')
    const child = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '子本', parent_id: root }),
    })).body.data!.id
    await newArticle(token, child, '占位')
    await api(`/api/notebooks/${root}`, { method: 'PUT', token, body: j({ is_private: 1 }) })

    const dump = await exportAll(token)
    await dropAll()
    const token2 = await bootstrap('restored', 'test-password')
    await api('/api/import', { method: 'POST', token: token2, body: JSON.stringify(dump) })

    const newChild = await env.DB.prepare("SELECT id FROM notebooks WHERE name = '子本'").first<{ id: number }>()
    const fresh = await newArticle(token2, newChild!.id, '恢复之后新建的')
    const row = await env.DB.prepare('SELECT is_private FROM articles WHERE id = ?').bind(fresh).first<{ is_private: number }>()
    expect(row!.is_private).toBe(1)
  })

  it('导进一个已有同名笔记本的库:不冲掉现有的层级与私密标志', async () => {
    // 与「settings 只在当前没有该项时才恢复」同一条规矩:
    // 往一个已经配好的站里导备份,不该把人家现在的结构挪走
    const token = await bootstrap()
    const a = await newNotebook(token, '技术')
    const b = (await api<{ id: number }>('/api/notebooks', {
      method: 'POST', token, body: j({ name: '归档', parent_id: a }),
    })).body.data!.id
    await newArticle(token, b, '甲')
    const dump = await exportAll(token)

    // 目标库里「归档」已存在且挂在根上
    await dropAll()
    const token2 = await bootstrap('restored', 'test-password')
    const existing = await newNotebook(token2, '归档')
    await api('/api/import', { method: 'POST', token: token2, body: JSON.stringify(dump) })

    const row = await env.DB.prepare('SELECT parent_id FROM notebooks WHERE id = ?').bind(existing).first<{ parent_id: number | null }>()
    expect(row!.parent_id).toBeNull() // 没被备份里的层级挪走
  })

  it('重复导入同一份备份:文章不翻倍,评论也不翻倍', async () => {
    const { token } = await seedEverything()
    const dump = await exportAll(token)

    await dropAll()
    const token2 = await bootstrap('restored', 'test-password')
    await api('/api/import', { method: 'POST', token: token2, body: JSON.stringify(dump) })
    await api('/api/import', { method: 'POST', token: token2, body: JSON.stringify(dump) })

    const arts = await env.DB.prepare('SELECT COUNT(*) AS c FROM articles').first<{ c: number }>()
    expect(arts!.c).toBe(2)
    // artMap 必须包含被去重跳过的文章,否则第二遍导入时它们的评论会挂不上而丢掉
    const cmts = await env.DB.prepare('SELECT COUNT(*) AS c FROM comments').first<{ c: number }>()
    expect(cmts!.c).toBe(1)
  })

  it('不是 CFNote 的备份文件直接拒绝', async () => {
    const token = await bootstrap()
    const res = await api('/api/import', { method: 'POST', token, body: j({ app: 'other', notebooks: [], articles: [] }) })
    expect(res.status).toBe(400)
  })
})
