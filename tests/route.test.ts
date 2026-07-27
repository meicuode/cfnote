import { describe, it, expect } from 'vitest'
import { parseLocation, buildLocation, isEmptyRoute, type RouteView } from '../src/lib/route'

describe('parseLocation', () => {
  it('裸根路径 → none / 空路由', () => {
    const r = parseLocation('/', '')
    expect(r.view).toEqual({ kind: 'none' })
    expect(r.articleId).toBeNull()
    expect(r.panel).toBeNull()
    expect(isEmptyRoute(r)).toBe(true)
  })

  it('真实笔记本 /nb/5', () => {
    expect(parseLocation('/nb/5', '').view).toEqual({ kind: 'notebook', id: 5 })
  })

  it('笔记本 + 文章 /nb/5/42', () => {
    const r = parseLocation('/nb/5/42', '')
    expect(r.view).toEqual({ kind: 'notebook', id: 5 })
    expect(r.articleId).toBe(42)
  })

  it('私有 / 回收站视图', () => {
    expect(parseLocation('/private', '').view).toEqual({ kind: 'private' })
    expect(parseLocation('/trash/9', '').view).toEqual({ kind: 'trash' })
    expect(parseLocation('/trash/9', '').articleId).toBe(9)
  })

  it('标签视图 + 中文/含空格标签解码', () => {
    const r = parseLocation('/tag/' + encodeURIComponent('前端 笔记') + '/7', '')
    expect(r.view).toEqual({ kind: 'tag', name: '前端 笔记' })
    expect(r.articleId).toBe(7)
  })

  it('标签名含斜杠也能往返(encode 为 %2F 不破坏路径段)', () => {
    const name = 'a/b'
    const loc = buildLocation({ view: { kind: 'tag', name }, articleId: null, panel: null })
    expect(parseLocation(loc, '').view).toEqual({ kind: 'tag', name })
  })

  it('tag 无名字段 → none', () => {
    expect(parseLocation('/tag', '').view).toEqual({ kind: 'none' })
  })

  it('非法/负/零文章 id 不入路由', () => {
    expect(parseLocation('/nb/5/0', '').articleId).toBeNull()
    expect(parseLocation('/nb/5/-3', '').articleId).toBeNull()
    expect(parseLocation('/nb/5/abc', '').articleId).toBeNull()
  })

  it('未知前缀 → none', () => {
    expect(parseLocation('/whatever/1', '').view).toEqual({ kind: 'none' })
  })

  it('?panel= 白名单过滤', () => {
    expect(parseLocation('/nb/5', '?panel=settings').panel).toBe('settings')
    expect(parseLocation('/nb/5', '?panel=files').panel).toBe('files')
    expect(parseLocation('/nb/5', '?panel=bogus').panel).toBeNull()
  })

  // P11.4:博客管理拆为两个内联子视图,各自可刷新保持
  it('博客管理两个子视图 blog/comments 往返', () => {
    expect(parseLocation('/nb/5', '?panel=blog').panel).toBe('blog')
    expect(parseLocation('/nb/5', '?panel=comments').panel).toBe('comments')
    expect(buildLocation({ view: { kind: 'none' }, articleId: null, panel: 'blog' })).toBe('/?panel=blog')
    expect(buildLocation({ view: { kind: 'none' }, articleId: null, panel: 'comments' })).toBe('/?panel=comments')
  })

  // P11.6:文件管理子视图(侧栏二级菜单)进 URL
  it('?fm= 解析:unref / nb:id / folder:id', () => {
    expect(parseLocation('/nb/5', '?panel=files&fm=unref').fm).toEqual({ kind: 'unref' })
    expect(parseLocation('/nb/5', '?panel=files&fm=nb:7').fm).toEqual({ kind: 'notebook', id: 7 })
    expect(parseLocation('/nb/5', '?panel=files&fm=folder:3').fm).toEqual({ kind: 'folder', id: 3 })
  })

  it('?fm= 非法值与非 files 面板一律回落 null', () => {
    expect(parseLocation('/nb/5', '?panel=files&fm=bogus').fm).toBeNull()
    expect(parseLocation('/nb/5', '?panel=files&fm=folder:0').fm).toBeNull()
    expect(parseLocation('/nb/5', '?panel=files&fm=nb:abc').fm).toBeNull()
    // 面板不是文件管理时,fm 无意义
    expect(parseLocation('/nb/5', '?panel=blog&fm=folder:3').fm).toBeNull()
    expect(parseLocation('/nb/5', '?fm=folder:3').fm).toBeNull()
  })

  it('fm 生成:仅 panel=files 且非 all 时才写进 URL', () => {
    const view: RouteView = { kind: 'notebook', id: 5 }
    expect(buildLocation({ view, articleId: null, panel: 'files', fm: { kind: 'folder', id: 3 } })).toBe('/nb/5?panel=files&fm=folder:3')
    expect(buildLocation({ view, articleId: null, panel: 'files', fm: { kind: 'notebook', id: 7 } })).toBe('/nb/5?panel=files&fm=nb:7')
    expect(buildLocation({ view, articleId: null, panel: 'files', fm: { kind: 'all' } })).toBe('/nb/5?panel=files')
    expect(buildLocation({ view, articleId: null, panel: 'files', fm: null })).toBe('/nb/5?panel=files')
    // 别的面板不带 fm
    expect(buildLocation({ view, articleId: null, panel: 'blog', fm: { kind: 'folder', id: 3 } })).toBe('/nb/5?panel=blog')
  })

  it('fm 往返一致', () => {
    const subs = [{ kind: 'unref' }, { kind: 'notebook', id: 7 }, { kind: 'folder', id: 3 }] as const
    for (const fm of subs) {
      const loc = buildLocation({ view: { kind: 'trash' }, articleId: null, panel: 'files', fm })
      const [path, search] = loc.split('?')
      expect(parseLocation(path, '?' + search).fm).toEqual(fm)
    }
  })

  it('兼容深链 ?article=7', () => {
    const r = parseLocation('/', '?article=7')
    expect(r.legacyArticleId).toBe(7)
    expect(isEmptyRoute(r)).toBe(false)
  })
})

describe('buildLocation', () => {
  const cases: Array<{ view: RouteView; articleId: number | null; panel: any; out: string }> = [
    { view: { kind: 'none' }, articleId: null, panel: null, out: '/' },
    { view: { kind: 'notebook', id: 5 }, articleId: null, panel: null, out: '/nb/5' },
    { view: { kind: 'notebook', id: 5 }, articleId: 42, panel: null, out: '/nb/5/42' },
    { view: { kind: 'private' }, articleId: 9, panel: null, out: '/private/9' },
    { view: { kind: 'trash' }, articleId: null, panel: null, out: '/trash' },
    { view: { kind: 'notebook', id: 5 }, articleId: 42, panel: 'settings', out: '/nb/5/42?panel=settings' },
    { view: { kind: 'none' }, articleId: null, panel: 'files', out: '/?panel=files' },
  ]
  for (const c of cases) {
    it(`生成 ${c.out}`, () => {
      expect(buildLocation({ view: c.view, articleId: c.articleId, panel: c.panel })).toBe(c.out)
    })
  }

  it('草稿负 id / 0 不写入 URL', () => {
    expect(buildLocation({ view: { kind: 'notebook', id: 5 }, articleId: -123, panel: null })).toBe('/nb/5')
    expect(buildLocation({ view: { kind: 'notebook', id: 5 }, articleId: 0, panel: null })).toBe('/nb/5')
  })

  it('none 视图不挂文章', () => {
    expect(buildLocation({ view: { kind: 'none' }, articleId: 42, panel: null })).toBe('/')
  })
})

describe('parse ∘ build 往返', () => {
  const routes: Array<{ view: RouteView; articleId: number | null; panel: any }> = [
    { view: { kind: 'notebook', id: 12 }, articleId: 34, panel: null },
    { view: { kind: 'private' }, articleId: null, panel: 'stats' },
    { view: { kind: 'trash' }, articleId: 8, panel: null },
    { view: { kind: 'tag', name: 'React' }, articleId: 5, panel: 'logs' },
    { view: { kind: 'none' }, articleId: null, panel: 'files' },
  ]
  for (const r of routes) {
    it(`${buildLocation(r)} 往返一致`, () => {
      const loc = buildLocation(r)
      const [path, search] = loc.split('?')
      const parsed = parseLocation(path, search ? '?' + search : '')
      expect(parsed.view).toEqual(r.view)
      expect(parsed.articleId).toBe(r.articleId)
      expect(parsed.panel).toBe(r.panel)
    })
  }
})
