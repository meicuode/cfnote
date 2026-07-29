// 博客 SEO / 预渲染的纯函数层(P12.6)。
//
// 这里只做「数据 → 字符串」,不碰 D1、不碰 HTMLRewriter,便于单测。
// 真正的请求处理在 worker/routes/pages.ts。
//
// 为什么需要服务端产出 HTML:微信/微博/Twitter/Slack 的链接预览抓取器与百度蜘蛛都**不执行 JS**,
// 凡是异步取回的内容它们一律看不到。要让它们看见,内容必须在第一份 HTML 的字节里。

import type { MenuItem } from './blogLayout'
import { usableMenu } from './blogLayout'

// ---- 预渲染档位(settings.blog_prerender)----
// 三档而不是布尔:出问题时「仅 meta」是一个中间落点——分享卡片和搜索摘要照常好用,只是正文不进 HTML。
export const PRERENDER_KEY = 'blog_prerender'
export type PrerenderMode = 'full' | 'meta' | 'off'

/**
 * 默认 full。这里刻意违反本项目「默认逐项等于改造前」的惯例:
 * 一旦 /blog/* 进了 Worker,off 档要付 HTML + API 两次计费请求,而 full 只付一次(正文与状态都内联,
 * 前端不再拉 /api/blog/posts/:id)。默认 off 等于让所有人落在最贵的一档,而两者的视觉与内容完全一致,
 * 所以破例的代价是零。
 */
export function parsePrerenderMode(v: unknown): PrerenderMode {
  return v === 'off' || v === 'meta' ? v : 'full'
}

// ---- 转义 ----

/** HTML 文本节点转义 */
export function escapeHtml(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** HTML 属性值转义(在 escapeHtml 基础上再管引号) */
export function escapeAttr(s: unknown): string {
  return escapeHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

/** XML 文本转义(sitemap / RSS 用;比 HTML 多一个单引号) */
export function escapeXml(s: unknown): string {
  return escapeAttr(s)
}

// U+2028/2029 用码位构造而不是写字面量:它们在编辑器与 diff 里显示成普通空白,
// 肉眼无法与空格区分,写错了就会把所有空格替换掉,而单测未必立刻发现。
const LINE_SEP = String.fromCharCode(0x2028)
const PARA_SEP = String.fromCharCode(0x2029)
const SCRIPT_ESCAPES: Record<string, string> = {
  '<': '\\u003c',
  [LINE_SEP]: '\\u2028',
  [PARA_SEP]: '\\u2029',
}
const SCRIPT_ESCAPE_RE = new RegExp('[<' + LINE_SEP + PARA_SEP + ']', 'g')

/**
 * 内联进 <script> 的 JSON。
 * 必须转义 `<`,否则文章正文里出现 `</script>` 就能提前闭合脚本标签、把后面的内容当 HTML 解析——
 * 这是内联状态最经典的注入口子。U+2028/2029 在 ES2019 之前不是合法的字符串字面量内容,一并转掉。
 */
export function jsonForScript(data: unknown): string {
  return JSON.stringify(data).replace(SCRIPT_ESCAPE_RE, (c) => SCRIPT_ESCAPES[c])
}

// ---- 时间 ----

/** SQLite 的 'YYYY-MM-DD HH:MM:SS' 是 UTC 且不带时区标记,补上 Z(与 BlogPage 的 toDate 同一套判断) */
export function toDate(d: string): Date {
  const s = String(d || '')
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + 'Z')
}

/** sitemap 的 <lastmod>;坏值返回空串(调用方据此省略该字段,不输出 Invalid Date) */
export function toIso(d: string): string {
  const t = toDate(d)
  return isNaN(t.getTime()) ? '' : t.toISOString()
}

const RFC822_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const RFC822_MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** RSS 的 <pubDate> 要 RFC-822(给 ISO 部分阅读器会解析失败) */
export function toRfc822(d: string): string {
  const t = toDate(d)
  if (isNaN(t.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return (
    `${RFC822_DAY[t.getUTCDay()]}, ${p2(t.getUTCDate())} ${RFC822_MON[t.getUTCMonth()]} ${t.getUTCFullYear()} ` +
    `${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())} GMT`
  )
}

// ---- URL ----

export function absUrl(origin: string, path: string): string {
  return String(origin || '').replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path)
}

/** 相对路径的图片(附件走 /api/files/…)要补成绝对地址,否则 og:image 在外站不可解析 */
export function absImage(origin: string, src: string | null | undefined): string {
  const s = String(src || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  if (s.startsWith('/')) return absUrl(origin, s)
  return ''
}

// ---- <head> ----

export interface SeoMeta {
  title: string
  description: string
  url: string
  image?: string
  siteName?: string
  publishedAt?: string
  updatedAt?: string
  tags?: string[]
  /** 私密分享、?preview=1 这类不该进索引的页面 */
  noindex?: boolean
}

/**
 * 详情页要注入的整段 <head> 补充。
 * 不含 <title>——标题走 HTMLRewriter 改写既有的 <title> 元素,避免出现两个。
 */
export function metaTags(m: SeoMeta): string {
  const out: string[] = []
  const push = (name: string, content: string, attr: 'name' | 'property' = 'name') => {
    if (content) out.push(`<meta ${attr}="${escapeAttr(name)}" content="${escapeAttr(content)}">`)
  }
  if (m.noindex) out.push('<meta name="robots" content="noindex, nofollow">')
  push('description', m.description)
  if (m.url) out.push(`<link rel="canonical" href="${escapeAttr(m.url)}">`)

  push('og:type', 'article', 'property')
  push('og:title', m.title, 'property')
  push('og:description', m.description, 'property')
  push('og:url', m.url, 'property')
  push('og:site_name', m.siteName || 'CFNote', 'property')
  push('og:image', m.image || '', 'property')
  if (m.publishedAt) push('article:published_time', toIso(m.publishedAt), 'property')
  if (m.updatedAt) push('article:modified_time', toIso(m.updatedAt), 'property')
  for (const t of (m.tags || []).slice(0, 6)) push('article:tag', t, 'property')

  // 有图用大图卡片,没图用摘要卡片(给 summary_large_image 却没有 image,部分平台会渲染成空白块)
  push('twitter:card', m.image ? 'summary_large_image' : 'summary')
  push('twitter:title', m.title)
  push('twitter:description', m.description)
  push('twitter:image', m.image || '')
  return out.join('')
}

/** 结构化数据:BlogPosting + 面包屑。两条合成一个数组,少一个 <script> */
export function jsonLd(m: SeoMeta & { tag?: string; origin: string }): string {
  const post: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: m.title,
    description: m.description,
    mainEntityOfPage: { '@type': 'WebPage', '@id': m.url },
    author: { '@type': 'Person', name: m.siteName || 'CFNote' },
    publisher: { '@type': 'Organization', name: m.siteName || 'CFNote' },
  }
  if (m.image) post.image = [m.image]
  if (m.publishedAt) post.datePublished = toIso(m.publishedAt)
  if (m.updatedAt) post.dateModified = toIso(m.updatedAt)
  if (m.tags && m.tags.length) post.keywords = m.tags.join(', ')

  const crumbs: unknown[] = [{ '@type': 'ListItem', position: 1, name: '首页', item: absUrl(m.origin, '/blog') }]
  if (m.tag) {
    crumbs.push({
      '@type': 'ListItem',
      position: 2,
      name: m.tag,
      item: absUrl(m.origin, '/blog?tag=' + encodeURIComponent(m.tag)),
    })
  }
  crumbs.push({ '@type': 'ListItem', position: crumbs.length + 1, name: m.title, item: m.url })

  const payload = [post, { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: crumbs }]
  return `<script type="application/ld+json">${jsonForScript(payload)}</script>`
}

/**
 * 首屏防闪主题脚本。
 *
 * 预渲染之后正文会在 JS 加载**之前**就绘制出来,而主题(跟随系统 / localStorage 手动选择)原本要等
 * React 挂载才知道——暗色用户会先看到一屏白底文字。故在 <head> 里同步决定一次,把类挂到 <html> 上;
 * `--blog-*` 是自定义属性,会继承给下面所有节点,预渲染块因此拿到正确配色,零 CSS 改动。
 *
 * 判定逻辑与 src/lib/blogTheme.ts 一致(手动选择优先,否则跟随系统,取不到时回退 dark)。
 * 那边是唯一事实来源,这里只是它在「JS 包到达之前」的一份最小复刻。
 */
export function themeBootScript(themeKey: string): string {
  const js =
    `(function(){try{var t=null;try{t=localStorage.getItem(${JSON.stringify(themeKey)})}catch(e){}` +
    `if(t!=='light'&&t!=='dark'){t=(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}` +
    `var c=document.documentElement.classList;c.add('cfnote-blog');if(t==='dark'){c.add('dark')}` +
    `}catch(e){}})()`
  return `<script>${js}</script>`
}

/**
 * 皮肤变量 + 博主自填的额外 CSS。
 * css 必须是调用方 sanitizeCss 之后的结果——这里是拼字符串输出,`</style>` 真的能逃逸
 * (React 侧走的是 <style> 文本节点,不经 HTML 解析器,那边本就逃不掉;P12.5 留的那道保险在这里派上用场)。
 */
export function skinStyleTag(vars: Record<string, string>, css: string): string {
  const decls = Object.entries(vars)
    .map(([k, v]) => `${k}:${String(v).replace(/[<>{}]/g, '')}`)
    .join(';')
  return `<style>:root{${decls}}</style>` + (css ? `<style>${css}</style>` : '')
}

// ---- 预渲染的正文块 ----

export interface PrerenderArticle {
  id: number
  title: string
  tag: string
  tags: string[]
  publishedAt: string
  views: number
  /** 已由 marked 渲染好的正文 HTML */
  bodyHtml: string
}

const fmtDay = (d: string): string => {
  const t = toDate(d)
  if (isNaN(t.getTime())) return ''
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`
}

/**
 * 注入 #root 的正文块。React 挂载时 createRoot 会清空容器,所以这块对最终用户是过渡态——
 * 它真正的服务对象是不执行 JS 的抓取器,以及「文字比 JS 先到」的首屏观感。
 *
 * 版式用内联 style 而不是 Tailwind 类:类名要被 Tailwind 扫到才会进产物,而本文件产出的是 worker 侧字符串,
 * 不在扫描范围内,写了也不会生效。正文容器保留 `cfnote-preview`——那是 index.css 里的实类,一定在。
 */
export function articleBlockHtml(a: PrerenderArticle, extraNav: string): string {
  const tags = [a.tag, ...(a.tags || [])].filter(Boolean)
  return (
    `<div id="cfnote-prerender" style="max-width:var(--blog-max,1400px);margin:0 auto;padding:24px 20px;` +
    `background:var(--blog-bg);color:var(--blog-text);min-height:100vh">` +
    `<nav style="font-size:15px;color:#8f8f8f"><a href="/blog" style="color:inherit">首页</a> &gt; ` +
    `<a href="/blog?tag=${escapeAttr(encodeURIComponent(a.tag))}" style="color:inherit">${escapeHtml(a.tag)}</a></nav>` +
    `<h1 style="font-size:28px;font-weight:700;line-height:1.35;margin:20px 0 0;color:var(--blog-title)">${escapeHtml(a.title)}</h1>` +
    `<div style="font-size:13px;color:#6b7280;margin-top:16px">` +
    `<span>${escapeHtml(fmtDay(a.publishedAt))}</span>` +
    `<span style="margin-left:20px">来源：CFNote 笔记</span>` +
    (tags.length ? `<span style="margin-left:20px">Tags：${tags.map((t) => escapeHtml(t)).join('、')}</span>` : '') +
    `<span style="margin-left:20px">浏览：${Number(a.views) || 0}</span>` +
    `</div>` +
    `<div class="cfnote-preview" style="margin-top:24px">${a.bodyHtml}</div>` +
    `<p style="text-align:center;color:#6b7280;font-size:14px;margin-top:48px">· 完 ·</p>` +
    extraNav +
    `</div>`
  )
}

export interface SeoLink {
  id: number
  title: string
}

export interface SeoNavInput {
  menu: MenuItem[]
  prev?: SeoLink | null
  next?: SeoLink | null
  related?: SeoLink[]
  tags?: string[]
}

/**
 * 纯链接内链块。
 *
 * 侧栏那 12 种模块不预渲染——那要求 worker 把每种模块的 HTML 再写一遍,加一个模块就得补一份,两份早晚走样
 * (与 P12.4 拒绝「仿真画布」是同一个论证)。但内链不能没有:抓取器靠它发现其他文章、传递权重,
 * 否则每篇文章都是孤岛。折中是只补「本来就没有渲染逻辑、只有一串链接」的那部分:
 * 菜单、上一篇/下一篇、相关文章、标签。这几样在数据层已是现成的结构化数据,拼几行 <a> 即可。
 */
export function seoNavHtml(n: SeoNavInput): string {
  const item = (href: string, text: string) =>
    `<a href="${escapeAttr(href)}" style="color:var(--blog-accent);margin-right:14px">${escapeHtml(text)}</a>`
  const groups: string[] = []

  const menu = usableMenu(n.menu || [])
  if (menu.length) groups.push('<div>' + menu.map((x) => item(x.href, x.item.label)).join('') + '</div>')

  const neighbors: string[] = []
  if (n.prev) neighbors.push(item(`/blog/${n.prev.id}`, '← 上一篇：' + n.prev.title))
  if (n.next) neighbors.push(item(`/blog/${n.next.id}`, '下一篇：' + n.next.title + ' →'))
  if (neighbors.length) groups.push('<div style="margin-top:8px">' + neighbors.join('') + '</div>')

  const related = (n.related || []).filter((r) => r && r.id)
  if (related.length) {
    groups.push(
      '<div style="margin-top:8px">相关文章：' + related.map((r) => item(`/blog/${r.id}`, r.title)).join('') + '</div>'
    )
  }

  const tags = (n.tags || []).filter(Boolean)
  if (tags.length) {
    groups.push(
      '<div style="margin-top:8px">标签：' +
        tags.map((t) => item('/blog?tag=' + encodeURIComponent(t), t)).join('') +
        '</div>'
    )
  }

  if (!groups.length) return ''
  return (
    `<nav style="margin-top:32px;padding-top:16px;border-top:1px solid var(--blog-border);font-size:14px">` +
    groups.join('') +
    `</nav>`
  )
}

// ---- robots / sitemap / feed ----

export function robotsTxt(origin: string): string {
  return [
    'User-agent: *',
    'Allow: /blog',
    // 管理端本来就要登录,抓也抓不到内容;显式挡掉省得浪费抓取预算
    'Disallow: /api/',
    // 私密分享是 unlisted:凭链接可看,但不该进索引
    'Disallow: /blog/share/',
    // 筛选结果页是 /blog 的近重复内容,不值得收录
    'Disallow: /blog?',
    '',
    `Sitemap: ${absUrl(origin, '/sitemap.xml')}`,
    '',
  ].join('\n')
}

export interface SitemapPost {
  id: number
  updated_at: string
}

/**
 * sitemap 是「加载更多」这个选择的必要配套:列表页每次只出 20 篇,不执行 JS 的抓取器看不到更多,
 * Googlebot 虽然执行 JS 但不会去点按钮。第 21 篇之后只能靠内链和这份 sitemap 被发现。
 */
export function sitemapXml(origin: string, posts: SitemapPost[]): string {
  const urls = [`<url><loc>${escapeXml(absUrl(origin, '/blog'))}</loc><changefreq>daily</changefreq></url>`]
  for (const p of posts) {
    const iso = toIso(p.updated_at)
    urls.push(
      `<url><loc>${escapeXml(absUrl(origin, '/blog/' + p.id))}</loc>` +
        (iso ? `<lastmod>${escapeXml(iso)}</lastmod>` : '') +
        `</url>`
    )
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`
}

export interface FeedPost {
  id: number
  title: string
  excerpt: string
  published_at: string
  tag?: string
}

/**
 * RSS 2.0。<description> 只放摘要不放全文:全文让 feed 体积随文章长度线性膨胀,
 * 而阅读器会反复拉整份 feed。要改成全文只是把 excerpt 换成渲染后的 HTML 一行的事。
 */
export function feedXml(opts: { origin: string; title: string; description: string; posts: FeedPost[] }): string {
  const self = absUrl(opts.origin, '/blog/feed.xml')
  const items = opts.posts.map((p) => {
    const link = absUrl(opts.origin, '/blog/' + p.id)
    const date = toRfc822(p.published_at)
    return (
      `<item><title>${escapeXml(p.title)}</title><link>${escapeXml(link)}</link>` +
      `<guid isPermaLink="true">${escapeXml(link)}</guid>` +
      (date ? `<pubDate>${escapeXml(date)}</pubDate>` : '') +
      (p.tag ? `<category>${escapeXml(p.tag)}</category>` : '') +
      `<description>${escapeXml(p.excerpt)}</description></item>`
    )
  })
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>` +
    `<title>${escapeXml(opts.title)}</title>` +
    `<link>${escapeXml(absUrl(opts.origin, '/blog'))}</link>` +
    `<description>${escapeXml(opts.description)}</description>` +
    `<language>zh-CN</language>` +
    `<atom:link href="${escapeXml(self)}" rel="self" type="application/rss+xml"/>` +
    items.join('') +
    `</channel></rss>`
  )
}
