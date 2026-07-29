import { describe, it, expect } from 'vitest'
import {
  parsePrerenderMode, escapeHtml, escapeAttr, jsonForScript,
  toIso, toRfc822, absUrl, absImage,
  metaTags, jsonLd, skinStyleTag, articleBlockHtml, seoNavHtml,
  robotsTxt, sitemapXml, feedXml, themeBootScript,
} from '../src/lib/blogSeo'
import type { MenuItem } from '../src/lib/blogLayout'
import { defaultArticleParts } from '../src/lib/blogArticleParts'

describe('parsePrerenderMode', () => {
  it('只认三个档位,其余一律回落 full', () => {
    expect(parsePrerenderMode('full')).toBe('full')
    expect(parsePrerenderMode('meta')).toBe('meta')
    expect(parsePrerenderMode('off')).toBe('off')
    // 未配置 = 默认开(见函数注释:off 档反而更贵,默认关掉等于让所有人落在最贵的一档)
    expect(parsePrerenderMode(undefined)).toBe('full')
    expect(parsePrerenderMode('')).toBe('full')
    expect(parsePrerenderMode('yes')).toBe('full')
    expect(parsePrerenderMode(null)).toBe('full')
  })
})

describe('转义', () => {
  it('escapeHtml 处理尖括号与 &', () => {
    expect(escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
    expect(escapeHtml(null)).toBe('')
  })

  it('escapeAttr 额外处理引号', () => {
    expect(escapeAttr('a"b\'c')).toBe('a&quot;b&#39;c')
  })

  it('jsonForScript 让正文里的 </script> 无法提前闭合脚本标签', () => {
    const out = jsonForScript({ content: 'x</script><script>alert(1)</script>' })
    expect(out).not.toContain('</script>')
    expect(out).toContain('\\u003c/script>')
    // 转义后仍是合法 JSON,能被 JSON.parse 还原
    expect(JSON.parse(out.replace(/\\u003c/g, '<')).content).toBe('x</script><script>alert(1)</script>')
  })

  it('jsonForScript 不动普通空格', () => {
    // U+2028/2029 在源码里显示成普通空白,曾经把正则写成了 / / 会把所有空格替换掉
    expect(jsonForScript({ a: 'hello world  x' })).toBe('{"a":"hello world  x"}')
  })
})

describe('时间', () => {
  it('SQLite 的无时区串按 UTC 解析', () => {
    expect(toIso('2026-07-24 07:26:56')).toBe('2026-07-24T07:26:56.000Z')
    expect(toRfc822('2026-07-24 07:26:56')).toBe('Fri, 24 Jul 2026 07:26:56 GMT')
  })

  it('已带时区的串原样解析', () => {
    expect(toIso('2026-07-24T07:26:56Z')).toBe('2026-07-24T07:26:56.000Z')
  })

  it('坏值返回空串而不是 Invalid Date', () => {
    expect(toIso('')).toBe('')
    expect(toIso('哪天')).toBe('')
    expect(toRfc822('哪天')).toBe('')
  })
})

describe('URL', () => {
  it('absUrl 去掉 origin 末尾多余斜杠', () => {
    expect(absUrl('https://a.com/', '/blog/1')).toBe('https://a.com/blog/1')
    expect(absUrl('https://a.com', 'blog/1')).toBe('https://a.com/blog/1')
  })

  it('absImage 只补站内相对路径,绝对地址原样,其余丢弃', () => {
    expect(absImage('https://a.com', '/api/files/x.png')).toBe('https://a.com/api/files/x.png')
    expect(absImage('https://a.com', 'https://b.com/x.png')).toBe('https://b.com/x.png')
    expect(absImage('https://a.com', 'x.png')).toBe('')
    expect(absImage('https://a.com', null)).toBe('')
  })
})

describe('metaTags', () => {
  const base = { title: '标题', description: '摘要', url: 'https://a.com/blog/1' }

  it('输出 canonical / og / twitter', () => {
    const h = metaTags(base)
    expect(h).toContain('<link rel="canonical" href="https://a.com/blog/1">')
    expect(h).toContain('<meta property="og:title" content="标题">')
    expect(h).toContain('<meta name="description" content="摘要">')
  })

  it('没有图时用 summary 卡片(给 large_image 却没图会渲染成空白块)', () => {
    expect(metaTags(base)).toContain('content="summary"')
    expect(metaTags({ ...base, image: 'https://a.com/x.png' })).toContain('content="summary_large_image"')
  })

  it('noindex 只在要求时出现', () => {
    expect(metaTags(base)).not.toContain('noindex')
    expect(metaTags({ ...base, noindex: true })).toContain('<meta name="robots" content="noindex, nofollow">')
  })

  it('标题里的引号不会撑破属性', () => {
    expect(metaTags({ ...base, title: 'a"><script>' })).not.toContain('<script>')
  })
})

describe('jsonLd', () => {
  it('产出可解析的 BlogPosting + BreadcrumbList', () => {
    const html = jsonLd({
      title: '标题', description: '摘要', url: 'https://a.com/blog/1',
      origin: 'https://a.com', tag: '运维', publishedAt: '2026-07-24 07:26:56',
    })
    const raw = html.replace(/^<script type="application\/ld\+json">/, '').replace(/<\/script>$/, '')
    const parsed = JSON.parse(raw.replace(/\\u003c/g, '<'))
    expect(parsed).toHaveLength(2)
    expect(parsed[0]['@type']).toBe('BlogPosting')
    expect(parsed[0].datePublished).toBe('2026-07-24T07:26:56.000Z')
    expect(parsed[1]['@type']).toBe('BreadcrumbList')
    // 首页 → 标签 → 本文
    expect(parsed[1].itemListElement).toHaveLength(3)
  })
})

describe('skinStyleTag', () => {
  it('把变量拼成 :root 声明', () => {
    expect(skinStyleTag({ '--blog-accent': '#d43030' }, '')).toBe('<style>:root{--blog-accent:#d43030}</style>')
  })

  it('变量值里的尖括号与花括号被剔除(拼字符串输出,不能让值越权)', () => {
    expect(skinStyleTag({ '--x': 'red}</style><script>' }, '')).not.toContain('<script>')
  })

  it('额外 CSS 为空时不产出第二个 style 标签', () => {
    expect(skinStyleTag({}, '').match(/<style>/g)).toHaveLength(1)
    expect(skinStyleTag({}, 'a{color:red}').match(/<style>/g)).toHaveLength(2)
  })
})

describe('articleBlockHtml', () => {
  const a = {
    id: 1, title: '<标题>', tag: '运维', tags: ['nginx'],
    publishedAt: '2026-07-24 07:26:56', views: 12, bodyHtml: '<p>正文</p>',
  }
  // 部件顺序与开关由 layout.article 决定(P12.8);更细的用例在 blogArticleParts.test.ts
  const parts = defaultArticleParts()

  it('标题转义,正文原样保留', () => {
    const h = articleBlockHtml(a, parts, '')
    expect(h).toContain('&lt;标题&gt;')
    expect(h).toContain('<p>正文</p>')
    // 正文容器必须是 index.css 里的实类:Tailwind 扫不到 worker 侧字符串里的类名
    expect(h).toContain('class="cfnote-preview"')
  })

  it('内链块拼在正文之后', () => {
    expect(articleBlockHtml(a, parts, '<nav>X</nav>')).toContain('<nav>X</nav>')
  })
})

describe('seoNavHtml', () => {
  const menu: MenuItem[] = [
    { id: '1', type: 'home', label: '首页', value: '' },
    { id: '2', type: 'link', label: '坏链', value: 'javascript:alert(1)' },
  ]

  it('配置不全/不安全的菜单项不渲染成死链', () => {
    const h = seoNavHtml({ menu })
    expect(h).toContain('href="/blog"')
    expect(h).not.toContain('javascript:')
  })

  it('上下篇与相关文章都出成 a 标签(内链是抓取器发现其他文章的唯一途径)', () => {
    const h = seoNavHtml({
      menu: [], prev: { id: 7, title: '前一篇' }, next: { id: 9, title: '后一篇' },
      related: [{ id: 11, title: '相关' }], tags: ['运维'],
    })
    expect(h).toContain('href="/blog/7"')
    expect(h).toContain('href="/blog/9"')
    expect(h).toContain('href="/blog/11"')
    expect(h).toContain('href="/blog?tag=%E8%BF%90%E7%BB%B4"')
  })

  it('什么都没有时返回空串,不留一个空 nav', () => {
    expect(seoNavHtml({ menu: [] })).toBe('')
  })
})

describe('robots / sitemap / feed', () => {
  it('robots 的 Sitemap 用绝对地址(fork 的人不用配域名)', () => {
    const t = robotsTxt('https://a.com')
    expect(t).toContain('Sitemap: https://a.com/sitemap.xml')
    // 私密分享是 unlisted,不该进索引
    expect(t).toContain('Disallow: /blog/share/')
  })

  it('sitemap 含列表页与每篇文章', () => {
    const x = sitemapXml('https://a.com', [{ id: 3, updated_at: '2026-07-24 07:26:56' }])
    expect(x).toContain('<loc>https://a.com/blog</loc>')
    expect(x).toContain('<loc>https://a.com/blog/3</loc>')
    expect(x).toContain('<lastmod>2026-07-24T07:26:56.000Z</lastmod>')
  })

  it('sitemap 坏时间只是省掉 lastmod,不产出 Invalid Date', () => {
    const x = sitemapXml('https://a.com', [{ id: 3, updated_at: '' }])
    expect(x).toContain('<loc>https://a.com/blog/3</loc>')
    expect(x).not.toContain('lastmod')
  })

  it('feed 用 RFC-822 时间与绝对 guid', () => {
    const x = feedXml({
      origin: 'https://a.com', title: 'T', description: 'D',
      posts: [{ id: 5, title: 'A&B', excerpt: '摘要', published_at: '2026-07-24 07:26:56', tag: '运维' }],
    })
    expect(x).toContain('<pubDate>Fri, 24 Jul 2026 07:26:56 GMT</pubDate>')
    expect(x).toContain('<guid isPermaLink="true">https://a.com/blog/5</guid>')
    expect(x).toContain('<title>A&amp;B</title>')
  })
})

describe('themeBootScript', () => {
  it('把主题键安全地嵌进脚本,并在 html 上挂 cfnote-blog', () => {
    const s = themeBootScript('cfnote:blog-theme')
    expect(s).toContain('"cfnote:blog-theme"')
    expect(s).toContain("c.add('cfnote-blog')")
    expect(s).toContain('prefers-color-scheme: dark')
  })
})
