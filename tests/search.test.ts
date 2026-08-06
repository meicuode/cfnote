import { describe, it, expect } from 'vitest'
import { escapeLike } from '../worker/routes/search'
import {
  findHitPositions, makeSnippets, snippetsOverlap, dedupeSnippets,
  highlightParts, compareExact, splitSlots,
  SNIPPET_BEFORE, SNIPPET_AFTER, HITS_PER_TERM, type Snippet,
} from '../src/lib/searchSnippets'

// ---- escapeLike:LIKE 特殊字符转义,防止 % _ 被当作通配符 ----

describe('escapeLike', () => {
  it('转义 % _ 和反斜杠', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    expect(escapeLike('a\\b')).toBe('a\\\\b')
  })

  it('普通中英文原样返回', () => {
    expect(escapeLike('向量搜索 test')).toBe('向量搜索 test')
  })
})

// ---- P17.5:片段摘录从「只取第一处」改成多窗口 ----

describe('findHitPositions', () => {
  it('多个词的位置合并后按升序,重复位置只算一次', () => {
    const c = 'x'.repeat(50) + 'Alpha' + 'y'.repeat(50) + 'beta' + 'z'.repeat(50)
    expect(findHitPositions(c, ['BETA', 'alpha'])).toEqual([50, 105])
    // 同一个词被列两次(去重发生在 terms 那层之前也不该重复计位置)
    expect(findHitPositions(c, ['alpha', 'alpha'])).toEqual([50])
  })

  it('同一个词的多次出现都记下来', () => {
    expect(findHitPositions('a猫b猫c猫', ['猫'])).toEqual([1, 3, 5])
  })

  it('单个词的命中数封顶,避免高频词扫出上万个位置', () => {
    const c = '词'.repeat(500)
    expect(findHitPositions(c, ['词'])).toHaveLength(HITS_PER_TERM)
  })

  it('空正文/空词/无命中都给空数组', () => {
    expect(findHitPositions('', ['a'])).toEqual([])
    expect(findHitPositions('abc', [''])).toEqual([])
    expect(findHitPositions('abc', ['zzz'])).toEqual([])
  })
})

describe('makeSnippets', () => {
  it('命中位置前后摘录并加省略号', () => {
    const content = 'a'.repeat(100) + '目标词' + 'b'.repeat(200)
    const [snip] = makeSnippets(content, ['目标词'])
    expect(snip).toContain('目标词')
    expect(snip.startsWith('…')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
    expect(snip.length).toBeLessThanOrEqual(SNIPPET_BEFORE + SNIPPET_AFTER + 2)
  })

  it('命中在开头时不加前省略号', () => {
    const [snip] = makeSnippets('目标词' + 'x'.repeat(300), ['目标词'])
    expect(snip.startsWith('目标词')).toBe(true)
    expect(snip.endsWith('…')).toBe(true)
  })

  it('相距很远的多处命中各出一段', () => {
    const content = '甲'.repeat(300) + '目标' + '乙'.repeat(300) + '目标' + '丙'.repeat(300)
    const snips = makeSnippets(content, ['目标'])
    expect(snips).toHaveLength(2)
    expect(snips[0]).toContain('甲')
    expect(snips[1]).toContain('乙')
  })

  it('挨得很近的命中并进同一段,不产出两段几乎一样的文字', () => {
    // 这是「同一段显示两遍」最容易发生的地方:窗口宽 160,两处只差 5 个字
    const content = '甲'.repeat(300) + '目标xxxxx目标' + '乙'.repeat(300)
    expect(makeSnippets(content, ['目标'])).toHaveLength(1)
  })

  it('无命中返回空数组,而不是正文开头', () => {
    // 调用方要能区分「命中了但摘不出来」和「压根没命中」——
    // 旧实现回落成正文前 160 字,于是纯语义结果看着像关键词命中
    expect(makeSnippets('c'.repeat(500), ['不存在'])).toEqual([])
  })

  it('max 限制段数', () => {
    const content = ['目标' + '甲'.repeat(300), '目标' + '乙'.repeat(300), '目标' + '丙'.repeat(300)].join('')
    expect(makeSnippets(content, ['目标'], 2)).toHaveLength(2)
  })
})

describe('snippetsOverlap', () => {
  it('一段完全包含另一段时算重复', () => {
    const long = '前'.repeat(60) + '核心内容' + '后'.repeat(60)
    expect(snippetsOverlap(long, '核心内容')).toBe(true)
  })

  it('共有足够长的连续片段算重复(切片之间本就重叠 100 字)', () => {
    const shared = '共'.repeat(60)
    expect(snippetsOverlap('甲'.repeat(80) + shared, shared + '乙'.repeat(80))).toBe(true)
  })

  it('只共有很短的片段不算重复', () => {
    expect(snippetsOverlap('甲'.repeat(80) + '的', '的' + '乙'.repeat(80))).toBe(false)
  })

  it('空白与省略号不参与判断', () => {
    expect(snippetsOverlap('…核心 内容…', '核心内容')).toBe(true)
  })

  it('空串一律不算重复', () => {
    expect(snippetsOverlap('', 'abc')).toBe(false)
    expect(snippetsOverlap('   ', 'abc')).toBe(false)
  })
})

describe('dedupeSnippets', () => {
  const S = (text: string, kind: Snippet['kind'] = 'exact'): Snippet => ({ text, kind })

  it('先来的赢:精确片段排在前面,于是不会被向量切片顶掉', () => {
    const body = '核'.repeat(60)
    const out = dedupeSnippets([S(body, 'exact'), S('前' + body + '后', 'semantic')])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('exact')
  })

  it('互不重叠的都留下,顺序不变', () => {
    const out = dedupeSnippets([S('甲'.repeat(80)), S('乙'.repeat(80), 'semantic')])
    expect(out.map((s) => s.kind)).toEqual(['exact', 'semantic'])
  })

  it('丢掉空片段', () => {
    expect(dedupeSnippets([S(''), S('   '), S('有内容')])).toHaveLength(1)
  })
})

describe('highlightParts', () => {
  it('命中的词切成独立 token', () => {
    expect(highlightParts('这是向量检索', ['向量'])).toEqual([
      { text: '这是', hit: false },
      { text: '向量', hit: true },
      { text: '检索', hit: false },
    ])
  })

  it('大小写不敏感,但保留原文的大小写', () => {
    const out = highlightParts('用 Vectorize 搜', ['vectorize'])
    expect(out.find((p) => p.hit)?.text).toBe('Vectorize')
  })

  it('长词优先,短词不会先把长词切开', () => {
    // 搜「笔记 笔」时若按输入顺序匹配,「笔记」会被「笔」切成两半
    const out = highlightParts('笔记本', ['笔', '笔记'])
    expect(out[0]).toEqual({ text: '笔记', hit: true })
    expect(out[1]).toEqual({ text: '本', hit: false })
  })

  it('同一个词多次出现都标出来', () => {
    expect(highlightParts('猫和猫', ['猫']).filter((p) => p.hit)).toHaveLength(2)
  })

  it('没有词时整段作为一个未命中 token', () => {
    expect(highlightParts('原文', [])).toEqual([{ text: '原文', hit: false }])
    expect(highlightParts('原文', [''])).toEqual([{ text: '原文', hit: false }])
  })

  it('拼回去等于原文(不丢字符)', () => {
    const src = 'abc向量def向量ghi'
    expect(highlightParts(src, ['向量']).map((p) => p.text).join('')).toBe(src)
  })

  it('空串给空数组', () => {
    expect(highlightParts('', ['a'])).toEqual([])
  })
})

describe('compareExact(第一层内部排序)', () => {
  const E = (allTerms: boolean, titleHit: boolean, hits: number) => ({ allTerms, titleHit, hits })

  it('全部词命中的排在部分命中之前,哪怕后者命中次数多得多', () => {
    // 关键词腿的 SQL 是 OR(命中任一词就进来),没有这一档的话
    // 搜「向量 检索」时只含「检索」的文章会和两个词都有的并列
    expect(compareExact(E(true, false, 1), E(false, true, 99))).toBeLessThan(0)
  })

  it('同为全部命中时,标题命中优先', () => {
    expect(compareExact(E(true, true, 1), E(true, false, 50))).toBeLessThan(0)
  })

  it('前两档相同时按命中次数降序', () => {
    expect(compareExact(E(true, true, 9), E(true, true, 3))).toBeLessThan(0)
    expect(compareExact(E(true, true, 3), E(true, true, 3))).toBe(0)
  })

  it('用作 sort 比较器时结果稳定可预期', () => {
    const list = [E(false, true, 100), E(true, false, 1), E(true, true, 1)]
    expect(list.sort(compareExact)).toEqual([E(true, true, 1), E(true, false, 1), E(false, true, 100)])
  })
})

describe('splitSlots(名额分配)', () => {
  it('精确命中很多时,仍给语义留出保底名额', () => {
    // 中文 LIKE 没有词边界,搜「本」会命中笔记本/本地/日本/基本——
    // 不留名额的话一个高频短词就能把语义腿整个挤没
    expect(splitSlots(50, 20)).toEqual({ exact: 7, semantic: 3 })
  })

  it('语义结果不足保底数时,名额还给精确层', () => {
    expect(splitSlots(50, 1)).toEqual({ exact: 9, semantic: 1 })
    expect(splitSlots(50, 0)).toEqual({ exact: 10, semantic: 0 })
  })

  it('精确层填不满时语义层顺延占满', () => {
    expect(splitSlots(2, 50)).toEqual({ exact: 2, semantic: 8 })
    expect(splitSlots(0, 50)).toEqual({ exact: 0, semantic: 10 })
  })

  it('两边都不多时全都要', () => {
    expect(splitSlots(2, 3)).toEqual({ exact: 2, semantic: 3 })
    expect(splitSlots(0, 0)).toEqual({ exact: 0, semantic: 0 })
  })

  it('负数与自定义上限不产出负名额', () => {
    expect(splitSlots(-5, -5)).toEqual({ exact: 0, semantic: 0 })
    expect(splitSlots(10, 10, 4, 2)).toEqual({ exact: 2, semantic: 2 })
    expect(splitSlots(10, 10, 2, 5)).toEqual({ exact: 0, semantic: 2 })
  })
})
