import { describe, it, expect } from 'vitest'
import {
  ARTICLE_PART_LABELS, DEFAULT_DIVIDER_TEXT, DEFAULT_SOURCE_TEXT, MAX_PART_TEXT,
  defaultArticleParts, parseArticleParts, isPartLocked, partFlag, findPart, articlePartOption,
  enabledArticleParts, moveArticlePart, toggleArticlePart, setArticlePartOption,
  type ArticlePartType,
} from '../src/lib/blogArticleParts'
import { defaultLayout, parseBlogLayout, serializeBlogLayout } from '../src/lib/blogLayout'
import { articleBlockHtml } from '../src/lib/blogSeo'

const types = (parts: { type: ArticlePartType }[]) => parts.map((p) => p.type)

describe('默认部件表', () => {
  it('等于改造前的详情页:面包屑 → 标题 → 元信息 → 正文 → 结束标记 → 评论', () => {
    const d = defaultArticleParts()
    expect(types(enabledArticleParts(d))).toEqual(['breadcrumb', 'title', 'meta', 'content', 'divider', 'comments'])
    // 新增能力默认关闭,不配置则页面零变化
    expect(findPart(d, 'tags')?.enabled).toBe(false)
    expect(findPart(d, 'copyright')?.enabled).toBe(false)
  })

  it('元信息四项默认全开,来源文字为原来那句', () => {
    const meta = findPart(defaultArticleParts(), 'meta')!
    expect(partFlag(meta, 'time')).toBe(true)
    expect(partFlag(meta, 'views')).toBe(true)
    expect(meta.options.sourceText).toBe(DEFAULT_SOURCE_TEXT)
  })

  it('每种类型都有中文名', () => {
    for (const p of defaultArticleParts()) expect(ARTICLE_PART_LABELS[p.type]).toBeTruthy()
  })
})

describe('parseArticleParts', () => {
  it('非数组回落默认', () => {
    expect(types(parseArticleParts(null))).toEqual(types(defaultArticleParts()))
    expect(types(parseArticleParts('oops'))).toEqual(types(defaultArticleParts()))
  })

  it('保留配置里的顺序,缺的补在末尾', () => {
    const parsed = parseArticleParts([{ type: 'content' }, { type: 'title' }])
    expect(parsed[0].type).toBe('content')
    expect(parsed[1].type).toBe('title')
    // 成员固定:其余六种都补齐了
    expect(parsed).toHaveLength(defaultArticleParts().length)
  })

  it('丢弃未知类型与重复项', () => {
    const parsed = parseArticleParts([{ type: 'nope' }, { type: 'title' }, { type: 'title' }, 42, null])
    expect(parsed.filter((p) => p.type === 'title')).toHaveLength(1)
    expect(types(parsed)).not.toContain('nope')
  })

  it('锁定的部件无论配置写什么都启用', () => {
    const parsed = parseArticleParts([{ type: 'content', enabled: false }, { type: 'comments', enabled: false }])
    expect(findPart(parsed, 'content')!.enabled).toBe(true)
    expect(findPart(parsed, 'comments')!.enabled).toBe(true)
    expect(isPartLocked('content')).toBe(true)
    expect(isPartLocked('title')).toBe(false)
  })

  it('options 只收字符串,超长截断,缺的用默认值补齐', () => {
    const parsed = parseArticleParts([{ type: 'meta', options: { time: '0', views: 1, sourceText: 'x'.repeat(9999) } }])
    const meta = findPart(parsed, 'meta')!
    expect(partFlag(meta, 'time')).toBe(false)
    // views 是数字,被丢弃 → 回落默认的 '1'
    expect(partFlag(meta, 'views')).toBe(true)
    expect(meta.options.sourceText).toHaveLength(MAX_PART_TEXT)
  })
})

describe('编辑', () => {
  it('moveArticlePart 换位,越界不动', () => {
    const d = defaultArticleParts()
    expect(types(moveArticlePart(d, 'title', -1))[0]).toBe('title')
    expect(types(moveArticlePart(d, 'breadcrumb', -1))).toEqual(types(d))
    expect(types(moveArticlePart(d, 'comments', 1))).toEqual(types(d))
    expect(types(moveArticlePart(d, '不存在' as ArticlePartType, 1))).toEqual(types(d))
  })

  it('toggleArticlePart 对锁定部件无效', () => {
    const d = defaultArticleParts()
    expect(findPart(toggleArticlePart(d, 'breadcrumb', false), 'breadcrumb')!.enabled).toBe(false)
    expect(findPart(toggleArticlePart(d, 'content', false), 'content')!.enabled).toBe(true)
  })

  it('setArticlePartOption 与 articlePartOption 对得上', () => {
    const l = setArticlePartOption(defaultArticleParts(), 'divider', 'text', '—— 全文完 ——')
    expect(articlePartOption(l, 'divider', 'text', DEFAULT_DIVIDER_TEXT)).toBe('—— 全文完 ——')
    // 空串取回落值(避免配置填空之后页面出现空标记)
    const empty = setArticlePartOption(l, 'divider', 'text', '')
    expect(articlePartOption(empty, 'divider', 'text', DEFAULT_DIVIDER_TEXT)).toBe(DEFAULT_DIVIDER_TEXT)
  })
})

describe('随布局一起存取', () => {
  it('defaultLayout 带上默认部件表', () => {
    expect(types(defaultLayout().article)).toEqual(types(defaultArticleParts()))
  })

  it('序列化后能原样读回', () => {
    const l = defaultLayout()
    l.article = moveArticlePart(l.article, 'title', -1)
    expect(types(parseBlogLayout(serializeBlogLayout(l)).article)[0]).toBe('title')
  })

  it('老配置(没有 article 字段)自动补默认,不至于渲染出空白文章', () => {
    const old = JSON.stringify({ list: defaultLayout().list, detail: defaultLayout().detail, menu: [] })
    expect(types(parseBlogLayout(old).article)).toEqual(types(defaultArticleParts()))
  })
})

describe('预渲染跟着同一份配置走', () => {
  const art = {
    id: 1, title: '标题', tag: '运维', tags: ['nginx'],
    publishedAt: '2026-07-24 07:26:56', views: 12,
    bodyHtml: '<p>正文</p>', copyrightHtml: '<p>版权</p>',
  }

  it('默认配置产出的顺序与页面一致', () => {
    const html = articleBlockHtml(art, defaultArticleParts(), '')
    expect(html.indexOf('首页')).toBeLessThan(html.indexOf('<h1'))
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('cfnote-preview'))
    expect(html).toContain(DEFAULT_DIVIDER_TEXT)
    expect(html).toContain(DEFAULT_SOURCE_TEXT)
  })

  it('停用的部件不出现在 HTML 里', () => {
    let parts = toggleArticlePart(defaultArticleParts(), 'breadcrumb', false)
    parts = toggleArticlePart(parts, 'divider', false)
    const html = articleBlockHtml(art, parts, '')
    expect(html).not.toContain('首页')
    expect(html).not.toContain(DEFAULT_DIVIDER_TEXT)
    // 正文永远在
    expect(html).toContain('<p>正文</p>')
  })

  it('换了顺序,HTML 跟着换', () => {
    const parts = moveArticlePart(defaultArticleParts(), 'title', -1)
    const html = articleBlockHtml(art, parts, '')
    expect(html.indexOf('<h1')).toBeLessThan(html.indexOf('首页'))
  })

  it('元信息子开关生效,来源文字被转义', () => {
    let parts = setArticlePartOption(defaultArticleParts(), 'meta', 'views', '0')
    parts = setArticlePartOption(parts, 'meta', 'sourceText', '<script>x</script>')
    const html = articleBlockHtml(art, parts, '')
    expect(html).not.toContain('浏览：')
    expect(html).not.toContain('<script>')
  })

  it('评论区从不预渲染(变化频率远高于文章,会毁掉边缘缓存)', () => {
    const html = articleBlockHtml(art, defaultArticleParts(), '')
    expect(html).not.toContain('评论')
  })

  it('版权声明启用后才出,且用的是 worker 侧渲染好的 HTML', () => {
    expect(articleBlockHtml(art, defaultArticleParts(), '')).not.toContain('<p>版权</p>')
    const parts = toggleArticlePart(defaultArticleParts(), 'copyright', true)
    expect(articleBlockHtml(art, parts, '')).toContain('<p>版权</p>')
  })
})
