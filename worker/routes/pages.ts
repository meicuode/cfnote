import { Hono } from 'hono'
import type { Context } from 'hono'
import { getSettingValue } from '../utils'
import { marked } from '../../src/lib/markdown'
import { mdExcerpt, mdFirstImage } from '../../src/lib/blogExtract'
import { skinVars, sanitizeCss } from '../../src/lib/blogSkin'
import { BLOG_THEME_KEY } from '../../src/lib/blogTheme'
import {
  PRERENDER_KEY, parsePrerenderMode, metaTags, jsonLd, themeBootScript, skinStyleTag,
  articleBlockHtml, seoNavHtml, jsonForScript, absImage, absUrl,
  robotsTxt, sitemapXml, feedXml,
  type PrerenderMode,
} from '../../src/lib/blogSeo'
import { loadBlogDetail, countBlogView } from './blog'
import { listSitemapPosts, listFeedPosts } from '../repo/blogRepo'
import { articlePartOption } from '../../src/lib/blogArticleParts'
import { postPath } from '../../src/lib/blogSlug'
import type { AppEnv } from '../types'

// 页面级路由(P12.6):详情页 HTML 预渲染 + robots / sitemap / feed。
//
// 这几条路径要在 wrangler.toml 的 run_worker_first 里声明才进得来——否则 not_found_handling
// = "single-page-application" 会把它们直接回落成 index.html,Worker 根本不跑。
//
// 成本模型的变化必须记住:/blog/:id 从「静态资源(免费不限量)」变成了「Worker 请求(计费)」。
// 完整预渲染档把 /api/blog/posts/:id 那次请求省掉了,所以计费请求数仍是 1;
// 但「仅 meta」与「关闭」两档是 HTML + API 两次,比改造前贵一次。见 blogSeo.parsePrerenderMode 的注释。
export const pages = new Hono<AppEnv>()

const SITE_NAME = 'CFNote 博客'
const PRERENDER_TTL = 60

/** 原样把静态资源发出去(未开预渲染 / 预览 / 私密分享 / 没有 ASSETS 绑定时) */
async function passthrough(env: AppEnv['Bindings'], req: Request, extraHeaders?: Record<string, string>) {
  if (!env.ASSETS) return new Response('Not found', { status: 404 })
  const res = await env.ASSETS.fetch(req)
  if (!extraHeaders) return res
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(extraHeaders)) out.headers.set(k, v)
  return out
}

/** SPA 外壳(dist/index.html)。取的是绑定内部资源,不是外网往返 */
async function shell(env: AppEnv['Bindings'], origin: string) {
  return env.ASSETS!.fetch(new Request(absUrl(origin, '/index.html')))
}

const edgeCache = () => {
  try {
    // 类型断言同 blog.ts:tsconfig 含 DOM lib,caches 解析为 DOM CacheStorage(无 default)
    return (caches as unknown as { default: Cache }).default
  } catch {
    return null
  }
}

// 注意注册顺序:/blog/feed.xml 必须在 /blog/:id 之前,否则会被后者按 :id 吃掉。
pages.get('/blog/feed.xml', async (c) => {
  const origin = new URL(c.req.url).origin
  try {
    const posts = await listFeedPosts(c.env, 20)
    const xml = feedXml({ origin, title: SITE_NAME, description: '来自 CFNote 笔记的公开文章', posts })
    return new Response(xml, {
      headers: { 'content-type': 'application/rss+xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    })
  } catch {
    return new Response('', { status: 503 })
  }
})

// 私密分享是 unlisted:凭链接可看,但绝不该进索引(robots.txt 也挡了一道)
pages.get('/blog/share/:token', async (c) => passthrough(c.env, c.req.raw, { 'X-Robots-Tag': 'noindex, nofollow' }))

/**
 * GET /blog/:id 与 /blog/:id/:slug —— 详情页 HTML。
 *
 * slug 段(P15.2)纯属装饰:查表只认 :id,:slug 一律不读,写错、过期、缺失都照常出内容。
 * 因此改标题不会断链——老地址仍然指向同一篇,只是 canonical 指向新的规范形态。
 * 站内链接一律直发规范地址(见 src/lib/blogSlug.postPath),所以正常浏览不会出现非规范 URL。
 *
 * full:<head> 全套 + 正文 + 纯链接内链 + 内联状态(前端不再打 API)
 * meta:只注入 <head>,正文仍由客户端拉
 * off :原样透传
 */
const blogDetail = async (c: Context<AppEnv>) => {
  const req = c.req.raw
  const url = new URL(req.url)
  const origin = url.origin
  // 抽成独立函数后 Context 不再带路径字面量,param 的类型退化成 string | undefined;
  // 下面那条数字判断本来就会把空串挡掉,这里补个默认值即可,不必为类型再造一层泛型
  const id = c.req.param('id') || ''

  // 只处理数字 id。feed.xml、share/… 等由各自的路由或透传接管
  if (!/^\d+$/.test(id)) return passthrough(c.env, req)
  // 布局配置页的 iframe 预览:保持改造前的行为(客户端拉数据、不计浏览量),并且不该进索引
  if (c.req.query('preview') === '1') return passthrough(c.env, req, { 'X-Robots-Tag': 'noindex' })
  if (!c.env.ASSETS) return passthrough(c.env, req)

  let mode: PrerenderMode = 'full'
  try {
    mode = parsePrerenderMode(await getSettingValue(c.env, PRERENDER_KEY, 'full'))
  } catch {
    /* 设置读不到(表未初始化等):按默认档继续,失败会在下面的 try 里兜底透传 */
  }
  if (mode === 'off') return passthrough(c.env, req)

  const ip = c.req.header('cf-connecting-ip') || ''
  const cache = edgeCache()
  // 档位进缓存键:改了开关立刻生效,不必等 TTL 过期(否则看起来像开关失灵)。
  // slug **不进**缓存键:同一篇文章不管从哪个地址进来,产出的 HTML 完全一样
  // (canonical 由标题算,与请求路径无关);放进去只会把同一份内容缓存成好几份。
  const cacheKey = new Request(`https://prerender.cfnote.internal/blog/${id}?m=${mode}`)

  if (cache) {
    try {
      const hit = await cache.match(cacheKey)
      if (hit) {
        // 命中缓存也要计数:否则 TTL 窗口内的访客全不算数(计数本身仍按 IP 每小时去重)
        c.executionCtx.waitUntil(countBlogView(c.env, id, ip).catch(() => false))
        return hit
      }
    } catch {
      /* 缓存不可用(本地 dev / workers.dev 域名):退化为每次现做 */
    }
  }

  try {
    const [data, base] = await Promise.all([
      loadBlogDetail(c.env, id, { ip, waitUntil: (p) => c.executionCtx.waitUntil(p) }),
      shell(c.env, origin),
    ])

    // 不存在/未公开:今天返回的是 200 + SPA 外壳(标准的 soft-404)。给真 404 + noindex。
    if (!data) {
      return new Response(base.body, {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex' },
      })
    }

    const content = String(data.content || '')
    const canonical = absUrl(origin, postPath(id, data.title))
    const description = mdExcerpt(content.slice(0, 3000), 150)
    const image = absImage(origin, mdFirstImage(content.slice(0, 3000)))
    const title = `${data.title} - ${SITE_NAME}`

    const seo = {
      title: String(data.title || ''),
      description,
      url: canonical,
      image,
      siteName: SITE_NAME,
      publishedAt: data.published_at,
      updatedAt: data.updated_at,
      tags: [data.tag, ...(data.tags || [])].filter(Boolean) as string[],
    }

    let head =
      themeBootScript(BLOG_THEME_KEY) +
      skinStyleTag(skinVars(data.skin), sanitizeCss(data.skin?.css || '')) +
      metaTags(seo) +
      jsonLd({ ...seo, tag: data.tag, origin }) +
      `<link rel="alternate" type="application/rss+xml" title="${SITE_NAME}" href="${absUrl(origin, '/blog/feed.xml')}">`

    let body = ''
    if (mode === 'full') {
      // 单页(P13.4):部件表换成 pageArticle,内链块里不出「上一篇/下一篇」与「相关文章」
      // ——单页不在文章流里,loadBlogDetail 也刻意没给它算这两份数据。
      const isPage = !!data.is_page
      const nav = seoNavHtml({
        menu: data.layout?.menu || [],
        prev: isPage ? null : (data.neighbors?.prev || null),
        next: isPage ? null : (data.neighbors?.next || null),
        related: isPage ? [] : (data.related || []),
        tags: isPage ? [] : ([data.tag, ...(data.tags || [])].filter(Boolean) as string[]),
      })
      const parts = (isPage ? data.layout?.pageArticle : data.layout?.article) || []
      const copyright = articlePartOption(parts, 'copyright', 'text', '').trim()
      body = articleBlockHtml(
        {
          id: Number(id),
          title: String(data.title || ''),
          tag: String(data.tag || ''),
          tags: (data.tags || []) as string[],
          publishedAt: String(data.published_at || ''),
          views: Number(data.views) || 0,
          // 与客户端 BlogPage.renderMd 同一个 marked 实例、同一份配置,输出同一个字符串
          bodyHtml: marked(content, { breaks: true }) as string,
          copyrightHtml: copyright ? (marked(copyright, { breaks: true }) as string) : '',
        },
        parts,
        nav
      )
      // 内联状态:前端读到就不再打 /api/blog/posts/:id,计费请求维持 1 次
      head += `<script>window.__CFNOTE_BLOG__=${jsonForScript({ id: Number(id), data })}</script>`
    }

    const rewriter = new HTMLRewriter()
      .on('title', { element: (el) => { el.setInnerContent(title) } })
      .on('head', { element: (el) => { el.append(head, { html: true }) } })
    if (body) rewriter.on('div#root', { element: (el) => { el.setInnerContent(body, { html: true }) } })

    const transformed = rewriter.transform(base)
    const res = new Response(transformed.body, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // max-age=0 让浏览器每次回源(否则读者看到的浏览数会冻住、且不计数);s-maxage 只给边缘缓存用
        'cache-control': `public, max-age=0, s-maxage=${PRERENDER_TTL}`,
      },
    })
    if (cache) {
      try {
        c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()))
      } catch {
        /* 同上,缓存不可用时忽略 */
      }
    }
    return res
  } catch {
    // 预渲染出任何问题都不该让博客页打不开——退回原样透传(等价于 off 档)
    return passthrough(c.env, req)
  }
}

// 两条路径同一个处理函数。带 slug 的那条要单独注册:Hono 的 `:id` 只吃一段,
// 不注册的话 /blog/12/xxx 会掉进 not_found_handling 变成 SPA 外壳(soft-404)。
// /blog/share/:token 与 /blog/feed.xml 都注册在前,不会被这两条抢走。
pages.get('/blog/:id', blogDetail)
pages.get('/blog/:id/:slug', blogDetail)

// GET /sitemap.xml —— 「加载更多」的必要配套:第 21 篇之后抓取器只能靠它发现
pages.get('/sitemap.xml', async (c) => {
  const origin = new URL(c.req.url).origin
  try {
    const posts = await listSitemapPosts(c.env)
    return new Response(sitemapXml(origin, posts), {
      headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' },
    })
  } catch {
    return new Response('', { status: 503 })
  }
})

// GET /robots.txt —— Sitemap 行用请求自身的 origin,fork 的人不用配域名
pages.get('/robots.txt', (c) => {
  const origin = new URL(c.req.url).origin
  return new Response(robotsTxt(origin), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  })
})
