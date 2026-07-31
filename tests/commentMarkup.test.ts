import { describe, it, expect } from 'vitest'
import {
  parseCommentMarkup, normalizeCommentText, countLinks, safeHref, MAX_COMMENT_LINKS,
  type Block, type Inline,
} from '../src/lib/commentMarkup'

// 取第一段的行内 token,省得每条断言都写一遍解构
const inlines = (src: string): Inline[] => {
  const b = parseCommentMarkup(src)[0]
  return b && b.t === 'p' ? b.c : []
}
const kinds = (src: string) => inlines(src).map((x) => x.t)

describe('safeHref:协议白名单(P13.9)', () => {
  it('只放 http/https', () => {
    expect(safeHref('https://a.com/x?y=1')).toBe('https://a.com/x?y=1')
    expect(safeHref('http://a.com')).toBe('http://a.com')
    expect(safeHref('  https://a.com  ')).toBe('https://a.com')
  })

  it('挡掉能执行/注入的那几种', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull()
    expect(safeHref('JavaScript:alert(1)')).toBeNull()
    expect(safeHref('data:text/html;base64,PHNjcmlwdD4=')).toBeNull()
    expect(safeHref('//evil.com')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
    expect(safeHref('')).toBeNull()
  })
})

describe('normalizeCommentText', () => {
  it('统一换行,3 个以上连续换行折成 2 个(防空白刷屏)', () => {
    expect(normalizeCommentText('a\r\nb')).toBe('a\nb')
    expect(normalizeCommentText('a\n\n\n\n\n\nb')).toBe('a\n\nb')
    expect(normalizeCommentText('  a  ')).toBe('a')
  })
})

describe('行内子集', () => {
  it('粗体/斜体/删除线/行内代码', () => {
    expect(inlines('**粗** *斜* ~~删~~ `码`').filter((x) => x.t !== 'text'))
      .toEqual([
        { t: 'strong', v: '粗' },
        { t: 'em', v: '斜' },
        { t: 'del', v: '删' },
        { t: 'code', v: '码' },
      ])
  })

  it('行内代码优先于加粗:`**x**` 里的星号不该被吃掉', () => {
    expect(inlines('`**x**`')).toEqual([{ t: 'code', v: '**x**' }])
  })

  it('不做嵌套,但内部允许出现单个星号', () => {
    // 加粗的内容原样是一段文本,不再递归解析成斜体
    expect(inlines('**a*b*c**')).toEqual([{ t: 'strong', v: 'a*b*c' }])
    expect(inlines('**a*b*c**').some((x) => x.t === 'em')).toBe(false)
    expect(inlines('~~a~b~~')).toEqual([{ t: 'del', v: 'a~b' }])
  })

  it('孤立的星号/波浪线不误伤', () => {
    expect(kinds('2 * 3 = 6')).toEqual(['text'])
    expect(kinds('a ~ b')).toEqual(['text'])
  })
})

describe('链接', () => {
  it('行内链接与裸链接都成 link,并保留 http/https', () => {
    expect(inlines('见 [这里](https://a.com)')).toEqual([
      { t: 'text', v: '见 ' },
      { t: 'link', href: 'https://a.com', v: '这里' },
    ])
    expect(inlines('见 https://a.com')).toEqual([
      { t: 'text', v: '见 ' },
      { t: 'link', href: 'https://a.com', v: 'https://a.com' },
    ])
  })

  it('协议非法的行内链接原样当文本显示,不变成可点的', () => {
    expect(inlines('[点我](javascript:alert(1))')).toEqual([
      { t: 'text', v: '[点我](javascript:alert(1))' },
    ])
    expect(inlines('[图](data:text/html,x)')).toEqual([{ t: 'text', v: '[图](data:text/html,x)' }])
  })

  it('裸链接后面粘的中文标点还给正文', () => {
    expect(inlines('见 https://a.com/x。')).toEqual([
      { t: 'text', v: '见 ' },
      { t: 'link', href: 'https://a.com/x', v: 'https://a.com/x' },
      { t: 'text', v: '。' },
    ])
  })

  it('[文字](URL) 里的 URL 不会被裸链接规则再吃一次', () => {
    expect(inlines('[a](https://a.com)').filter((x) => x.t === 'link')).toHaveLength(1)
  })

  it(`超过 ${MAX_COMMENT_LINKS} 个链接整条降级为纯文本`, () => {
    const spam = 'https://a.com https://b.com https://c.com https://d.com'
    expect(countLinks(spam)).toBe(4)
    expect(parseCommentMarkup(spam)).toEqual([{ t: 'plain', v: spam }])
    // 正好等于上限的仍然照常渲染
    const ok = 'https://a.com https://b.com https://c.com'
    expect(parseCommentMarkup(ok)[0].t).toBe('p')
  })

  it('协议非法的不计入链接数', () => {
    expect(countLinks('[a](javascript:1) [b](data:1) [c](vbscript:1)')).toBe(0)
  })
})

describe('块级子集', () => {
  const types = (src: string) => parseCommentMarkup(src).map((b: Block) => b.t)

  it('空行分段,段内单换行保留(交给 pre-wrap)', () => {
    const bs = parseCommentMarkup('第一段上\n第一段下\n\n第二段')
    expect(types('第一段上\n第一段下\n\n第二段')).toEqual(['p', 'p'])
    expect(bs[0]).toEqual({ t: 'p', c: [{ t: 'text', v: '第一段上\n第一段下' }] })
  })

  it('引用与列表各自成块,连续行合并', () => {
    const bs = parseCommentMarkup('> 引一\n> 引二\n- 甲\n- 乙\n正文')
    expect(bs.map((b) => b.t)).toEqual(['quote', 'ul', 'p'])
    expect(bs[1]).toEqual({ t: 'ul', items: [[{ t: 'text', v: '甲' }], [{ t: 'text', v: '乙' }]] })
  })

  it('行首的 *斜体* 不会被误判成列表项(列表要求符号后有空格)', () => {
    expect(types('*斜体*')).toEqual(['p'])
    expect(inlines('*斜体*')).toEqual([{ t: 'em', v: '斜体' }])
    expect(types('* 列表')).toEqual(['ul'])
  })

  it('不支持的语法原样当文本:标题、图片、表格、裸 HTML', () => {
    expect(types('# 标题')).toEqual(['p'])
    expect(inlines('# 标题')).toEqual([{ t: 'text', v: '# 标题' }])
    expect(inlines('<script>alert(1)</script>')).toEqual([{ t: 'text', v: '<script>alert(1)</script>' }])
    // 图片语法退化成一个普通链接的文本形态(前面那个 ! 留在正文里)
    expect(inlines('![图](https://a.com/x.png)')).toEqual([
      { t: 'text', v: '!' },
      { t: 'link', href: 'https://a.com/x.png', v: '图' },
    ])
  })

  it('空正文返回空数组', () => {
    expect(parseCommentMarkup('')).toEqual([])
    expect(parseCommentMarkup('   \n\n  ')).toEqual([])
  })
})
