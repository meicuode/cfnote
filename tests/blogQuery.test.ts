import { describe, it, expect } from 'vitest'
import {
  parseBlogFilter,
  isFiltered,
  filterKey,
  blogListUrl,
  blogListQuery,
  clampLimit,
  clampOffset,
  likeEscape,
  tagLikePattern,
  textLikePattern,
  buildTagCloud,
  relatedScore,
  scoreRelated,
  RELATED_NOTEBOOK_SCORE,
  RELATED_TAG_SCORE,
  PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_QUERY_LEN,
} from '../src/lib/blogQuery'

describe('parseBlogFilter(地址栏 → 筛选,P12.3)', () => {
  it('读 tag 与 q,顺带去空白', () => {
    expect(parseBlogFilter('?tag=%E8%BF%90%E7%BB%B4&q=%20nginx%20')).toEqual({ tag: '运维', q: 'nginx' })
  })

  it('没有参数就是空筛选', () => {
    expect(parseBlogFilter('')).toEqual({ tag: '', q: '' })
    expect(parseBlogFilter(null)).toEqual({ tag: '', q: '' })
    expect(parseBlogFilter('?other=1')).toEqual({ tag: '', q: '' })
  })

  it('超长筛选词被截断(挡住超长参数打满 SQL)', () => {
    const long = 'a'.repeat(200)
    expect(parseBlogFilter(`?q=${long}`).q).toHaveLength(MAX_QUERY_LEN)
  })

  it('isFiltered / filterKey', () => {
    expect(isFiltered({ tag: '', q: '' })).toBe(false)
    expect(isFiltered({ tag: '运维', q: '' })).toBe(true)
    expect(isFiltered({ tag: '', q: 'x' })).toBe(true)
    expect(filterKey({ tag: 'a', q: 'b' })).toBe(filterKey({ tag: 'a', q: 'b' }))
    expect(filterKey({ tag: 'a', q: 'b' })).not.toBe(filterKey({ tag: 'b', q: 'a' }))
  })
})

describe('blogListUrl / blogListQuery(P12.3)', () => {
  it('无筛选时是干净的 /blog,不留空 query 尾巴', () => {
    expect(blogListUrl({ tag: '', q: '' })).toBe('/blog')
  })

  it('带筛选时进地址栏(可复制、可后退)', () => {
    expect(blogListUrl({ tag: '运维', q: '' })).toBe('/blog?tag=%E8%BF%90%E7%BB%B4')
    expect(blogListUrl({ tag: '', q: 'a b' })).toBe('/blog?q=a+b')
    expect(parseBlogFilter(blogListUrl({ tag: '运维', q: 'x' }).slice('/blog'.length))).toEqual({ tag: '运维', q: 'x' })
  })

  it('请求 query:首页不带 offset,翻页才带', () => {
    expect(blogListQuery({ tag: '', q: '' }, 0)).toBe(`limit=${PAGE_SIZE}`)
    expect(blogListQuery({ tag: '', q: '' }, 20)).toBe(`limit=${PAGE_SIZE}&offset=20`)
    expect(blogListQuery({ tag: '运维', q: '' }, 0)).toBe(`limit=${PAGE_SIZE}&tag=%E8%BF%90%E7%BB%B4`)
  })

  it('limit/offset 夹取,坏值回落', () => {
    expect(clampLimit(undefined)).toBe(PAGE_SIZE)
    expect(clampLimit('abc')).toBe(PAGE_SIZE)
    expect(clampLimit(0)).toBe(PAGE_SIZE)
    expect(clampLimit(999)).toBe(MAX_PAGE_SIZE)
    expect(clampLimit('5')).toBe(5)
    expect(clampOffset(-3)).toBe(0)
    expect(clampOffset('40')).toBe(40)
    expect(clampOffset('x')).toBe(0)
  })
})

describe('LIKE 转义与匹配模式(P12.3)', () => {
  it('% _ \\ 三个通配字符要转义,否则搜 100% 会命中一切', () => {
    expect(likeEscape('100%')).toBe('100\\%')
    expect(likeEscape('a_b')).toBe('a\\_b')
    expect(likeEscape('a\\b')).toBe('a\\\\b')
  })

  it('标签连引号一起匹配:tags 存的是 ["a","b"],搜 a 不该命中 abc', () => {
    expect(tagLikePattern('a')).toBe('%"a"%')
    expect(JSON.stringify(['abc'])).not.toContain('"a"')
    expect(JSON.stringify(['a', 'b'])).toContain('"a"')
  })

  it('关键词是普通子串匹配', () => {
    expect(textLikePattern('ng_inx')).toBe('%ng\\_inx%')
  })
})

describe('buildTagCloud(标签云聚合,P12.3)', () => {
  it('笔记本名与文章标签同等计数,按次数降序;同次数按名称排序保证结果稳定', () => {
    expect(
      buildTagCloud([
        { tag: '运维', tags: ['nginx'] },
        { tag: '运维', tags: ['nginx', 'docker'] },
        { tag: '随笔', tags: [] },
      ])
    ).toEqual([
      { name: 'nginx', count: 2 },
      { name: '运维', count: 2 },
      { name: 'docker', count: 1 },
      { name: '随笔', count: 1 },
    ])
  })

  it('忽略空标签与空白标签,不同调用顺序结果稳定', () => {
    const a = buildTagCloud([{ tag: '', tags: ['  ', 'x'] }, { tag: null, tags: null }])
    expect(a).toEqual([{ name: 'x', count: 1 }])
  })

  it('取前 N 个', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ tag: `t${i}`, tags: [] }))
    expect(buildTagCloud(rows)).toHaveLength(30)
    expect(buildTagCloud(rows, 5)).toHaveLength(5)
  })

  it('空输入返回空数组', () => {
    expect(buildTagCloud([])).toEqual([])
  })
})

describe('scoreRelated(相关文章打分,P12.4)', () => {
  const seed = { id: 1, notebook_id: 10, tags: ['nginx', 'docker'] }

  it('同笔记本 +2,每个共同标签 +3', () => {
    expect(relatedScore(seed, { id: 2, notebook_id: 10, tags: [] })).toBe(RELATED_NOTEBOOK_SCORE)
    expect(relatedScore(seed, { id: 3, notebook_id: 99, tags: ['nginx'] })).toBe(RELATED_TAG_SCORE)
    expect(relatedScore(seed, { id: 4, notebook_id: 10, tags: ['nginx', 'docker'] })).toBe(
      RELATED_NOTEBOOK_SCORE + RELATED_TAG_SCORE * 2
    )
    expect(relatedScore(seed, { id: 5, notebook_id: 99, tags: ['无关'] })).toBe(0)
  })

  it('标签比笔记本更能说明主题相近:双标签命中排在同笔记本之前', () => {
    const out = scoreRelated(seed, [
      { id: 2, notebook_id: 10, tags: [] },
      { id: 3, notebook_id: 99, tags: ['nginx', 'docker'] },
    ], 5)
    expect(out.map((x) => x.id)).toEqual([3, 2])
  })

  it('排除自身与零分候选,取前 n 篇', () => {
    const out = scoreRelated(seed, [
      { id: 1, notebook_id: 10, tags: ['nginx'] }, // 自己
      { id: 2, notebook_id: 10, tags: [] },
      { id: 3, notebook_id: 99, tags: ['毫不相干'] }, // 零分
      { id: 4, notebook_id: 10, tags: ['docker'] },
    ], 1)
    expect(out.map((x) => x.id)).toEqual([4])
  })

  it('同分保持候选集原顺序(SQL 已按发布时间倒序,即新的在前)', () => {
    const out = scoreRelated(seed, [
      { id: 7, notebook_id: 10, tags: [] },
      { id: 8, notebook_id: 10, tags: [] },
      { id: 9, notebook_id: 10, tags: [] },
    ], 3)
    expect(out.map((x) => x.id)).toEqual([7, 8, 9])
  })

  it('没有笔记本也没有标签时谁都不相关', () => {
    expect(scoreRelated({ id: 1, notebook_id: null, tags: [] }, [{ id: 2, notebook_id: 3, tags: ['x'] }], 5)).toEqual([])
    expect(scoreRelated(seed, [], 5)).toEqual([])
  })
})
