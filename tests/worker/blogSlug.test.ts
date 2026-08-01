import { SELF } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { ORIGIN, api, j, bootstrap, newNotebook, newArticle, dropAll } from './_helpers'
import { postPath, slugify } from '../../src/lib/blogSlug'

// URL slug(P15.2)的端到端。slug 的**算法**在 tests/blogSlug.test.ts 里单测,
// 这里只管两件单测证不了的事:
//   ① /blog/:id/:slug 这条路由真的注册上了(Hono 的 `:id` 只吃一段,漏注册就掉进 SPA 回退);
//   ② sitemap 的 <loc> 真的带上了 slug——那要求 listSitemapPosts 的 SQL 多取一列 title。
//
// **测不到的**:预渲染出来的 HTML 与 canonical。wrangler.test.toml 刻意不声明 [assets]
// (见那个文件的注释:否则测试就依赖 ./dist 的构建产物),于是 env.ASSETS 缺失,
// 详情页一律走 passthrough 分支。这反倒给了 ① 一个干净的判据——两种 404 的响应体不同:
//   命中详情路由  → passthrough 的 'Not found'
//   没有任何路由  → app.notFound 的 '页面不存在: …'
// canonical 只能在生产上看。

const TITLE = '部署 Cloudflare Workers'

async function seedPublished() {
  const token = await bootstrap()
  const nb = await newNotebook(token)
  const id = await newArticle(token, nb, TITLE, '正文')
  const res = await api(`/api/articles/${id}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
  expect(res.body.ok, res.body.error).toBe(true)
  return { token, id }
}

/** 没有任何路由匹配时 app.notFound 给的响应体 */
const NO_ROUTE = '页面不存在'
/** 命中详情路由、但测试环境没有 ASSETS 时 passthrough 给的响应体 */
const HIT_ROUTE = 'Not found'

describe('/blog/:id/:slug 路由', () => {
  beforeEach(dropAll)

  it('带 slug 的地址命中详情路由,不掉进 SPA 回退', async () => {
    const { id } = await seedPublished()
    const res = await SELF.fetch(ORIGIN + postPath(id, TITLE))
    const body = await res.text()
    expect(body).toContain(HIT_ROUTE)
    expect(body).not.toContain(NO_ROUTE)
  })

  it('裸 id 的地址仍然命中同一条路由(slug 纯属装饰,不是必需的)', async () => {
    const { id } = await seedPublished()
    const body = await (await SELF.fetch(`${ORIGIN}/blog/${id}`)).text()
    expect(body).toContain(HIT_ROUTE)
    expect(body).not.toContain(NO_ROUTE)
  })

  it('slug 写错/过期照常命中——查表只认 id,所以改标题不会把老链接变成 404', async () => {
    const { id } = await seedPublished()
    for (const wrong of ['完全对不上的旧标题', 'xxx', slugify('改名之前的标题')]) {
      const body = await (await SELF.fetch(`${ORIGIN}/blog/${id}/${encodeURIComponent(wrong)}`)).text()
      expect(body, `slug=${wrong}`).toContain(HIT_ROUTE)
    }
  })

  it('三段路径仍然掉回 SPA:/blog/:id/:slug 只多吃一段,不是通配', async () => {
    const { id } = await seedPublished()
    const body = await (await SELF.fetch(`${ORIGIN}/blog/${id}/a/b`)).text()
    expect(body).toContain(NO_ROUTE)
  })

  it('/blog/share/:token 没被新路由抢走(它是两段,注册在前)', async () => {
    await seedPublished()
    const body = await (await SELF.fetch(`${ORIGIN}/blog/share/${'a'.repeat(32)}`)).text()
    // 私密分享同样走 passthrough,但它必须是 share 那条路由处理的——
    // 若被 /blog/:id/:slug 抢走,id='share' 过不了数字判断,一样是 passthrough,
    // 所以这里能断言的是「没变成 404 页面不存在」
    expect(body).not.toContain(NO_ROUTE)
  })
})

describe('sitemap 的 slug', () => {
  beforeEach(dropAll)

  it('<loc> 带 slug,且是 percent-encode 过的合法 XML', async () => {
    const { id } = await seedPublished()
    const res = await SELF.fetch(`${ORIGIN}/sitemap.xml`)
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain(`<loc>${ORIGIN}${postPath(id, TITLE)}</loc>`)
    // slug 段里不该出现未转义的 XML 特殊字符(标题里的 & < > 都被 slug 规则丢掉了)
    expect(xml).toContain(`/blog/${id}/${encodeURIComponent('部署-cloudflare-workers')}`)
  })

  it('标题算不出 slug 的文章退回裸 id,不产出半截地址', async () => {
    const token = await bootstrap()
    const nb = await newNotebook(token)
    const id = await newArticle(token, nb, '???', '正文')
    await api(`/api/articles/${id}`, { method: 'PUT', token, body: j({ is_public: 1 }) })
    const xml = await (await SELF.fetch(`${ORIGIN}/sitemap.xml`)).text()
    expect(xml).toContain(`<loc>${ORIGIN}/blog/${id}</loc>`)
  })
})
