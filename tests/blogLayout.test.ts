import { describe, it, expect } from 'vitest'
import {
  defaultLayout,
  parseBlogLayout,
  serializeBlogLayout,
  enabledWidgets,
  toggleWidget,
  updateWidget,
  moveWidget,
  locateWidget,
  addWidget,
  removeWidget,
  BLOG_LAYOUT_KEY,
} from '../src/lib/blogLayout'

describe('parseBlogLayout(容错解析,P12.1)', () => {
  it('空值/坏 JSON 一律回落默认(布局坏了也不能让博客页打不开)', () => {
    const def = defaultLayout()
    expect(parseBlogLayout(null)).toEqual(def)
    expect(parseBlogLayout('')).toEqual(def)
    expect(parseBlogLayout('   ')).toEqual(def)
    expect(parseBlogLayout('{ 不是 json')).toEqual(def)
    expect(parseBlogLayout('123')).toEqual(def)
    expect(parseBlogLayout('{"foo":1}')).toEqual(def)
  })

  it('默认布局等于改造前的样子:列表页右栏热榜+关于本站,详情页右栏只有热榜', () => {
    const def = defaultLayout()
    expect(def.list.right.map((w) => w.type)).toEqual(['hot', 'about'])
    expect(def.detail.right.map((w) => w.type)).toEqual(['hot'])
    expect(def.list.top).toEqual([])
    expect(def.list.bottom).toEqual([])
  })

  it('往返序列化不失真', () => {
    const def = defaultLayout()
    expect(parseBlogLayout(serializeBlogLayout(def))).toEqual(def)
  })

  it('丢弃未知类型的模块,保留认识的', () => {
    const raw = JSON.stringify({
      list: { top: [{ id: 'x', type: '不存在的类型' }, { id: 'h', type: 'hot' }], right: [], bottom: [] },
      detail: { top: [], right: [], bottom: [] },
    })
    const l = parseBlogLayout(raw)
    expect(l.list.top.map((w) => w.id)).toEqual(['h'])
  })

  it('只配了一个页面时,另一个页面用默认值', () => {
    const l = parseBlogLayout(JSON.stringify({ list: { top: [], right: [], bottom: [] } }))
    expect(l.list.right).toEqual([])
    expect(l.detail.right.map((w) => w.type)).toEqual(['hot']) // 未配置 → 默认
  })

  it('槽位不是数组、options 含非字符串值都能容忍', () => {
    const raw = JSON.stringify({
      list: { top: 'oops', right: [{ id: 'a', type: 'about', options: { text: 'hi', n: 5 } }] },
      detail: {},
    })
    const l = parseBlogLayout(raw)
    expect(l.list.top).toEqual([])
    expect(l.list.right[0].options).toEqual({ text: 'hi' })
    expect(l.detail.right).toEqual([])
  })

  it('enabled 缺省视为启用,显式 false 才关闭', () => {
    const raw = JSON.stringify({
      list: { right: [{ id: 'a', type: 'hot' }, { id: 'b', type: 'about', enabled: false }] },
      detail: {},
    })
    const l = parseBlogLayout(raw)
    expect(l.list.right[0].enabled).toBe(true)
    expect(l.list.right[1].enabled).toBe(false)
    expect(enabledWidgets(l.list, 'right').map((w) => w.id)).toEqual(['a'])
  })

  it('settings 键名固定', () => {
    expect(BLOG_LAYOUT_KEY).toBe('blog_layout')
  })
})

describe('布局编辑操作(不可变,P12.1)', () => {
  it('toggleWidget 只翻转目标模块,且不改入参', () => {
    const l = defaultLayout()
    const next = toggleWidget(l, 'list', 'about')
    expect(next.list.right.find((w) => w.id === 'about')!.enabled).toBe(false)
    expect(next.list.right.find((w) => w.id === 'hot')!.enabled).toBe(true)
    expect(l.list.right.find((w) => w.id === 'about')!.enabled).toBe(true) // 入参没被改
  })

  it('updateWidget 改标题与选项,但不允许改 id', () => {
    const l = updateWidget(defaultLayout(), 'list', 'about', { title: '简介', options: { text: '新正文' }, id: '篡改' } as any)
    const w = l.list.right.find((x) => x.id === 'about')!
    expect(w.title).toBe('简介')
    expect(w.options.text).toBe('新正文')
  })

  it('moveWidget 跨槽位移动', () => {
    const l = moveWidget(defaultLayout(), 'list', 'about', 'bottom', 0)
    expect(l.list.right.map((w) => w.id)).toEqual(['hot'])
    expect(l.list.bottom.map((w) => w.id)).toEqual(['about'])
  })

  it('moveWidget 同槽位换序(下标按摘出后计算)', () => {
    const l = moveWidget(defaultLayout(), 'list', 'hot', 'right', 1)
    expect(l.list.right.map((w) => w.id)).toEqual(['about', 'hot'])
  })

  it('moveWidget 下标越界夹到两端;id 不存在原样返回', () => {
    const l = moveWidget(defaultLayout(), 'list', 'about', 'top', 99)
    expect(l.list.top.map((w) => w.id)).toEqual(['about'])
    const same = moveWidget(defaultLayout(), 'list', '不存在', 'top', 0)
    expect(same).toEqual(defaultLayout())
  })

  it('locateWidget 报告槽位与下标', () => {
    expect(locateWidget(defaultLayout().list, 'about')).toEqual({ slot: 'right', index: 1 })
    expect(locateWidget(defaultLayout().list, '没有')).toBeNull()
  })

  it('addWidget 追加到槽位末尾并生成唯一 id', () => {
    let l = addWidget(defaultLayout(), 'list', 'top', 'hot')
    expect(l.list.top.map((w) => w.id)).toEqual(['hot-2']) // 'hot' 已被右栏占用
    l = addWidget(l, 'list', 'top', 'hot')
    expect(l.list.top.map((w) => w.id)).toEqual(['hot-2', 'hot-3'])
  })

  it('removeWidget 删除并保留其余', () => {
    const l = removeWidget(defaultLayout(), 'list', 'hot')
    expect(l.list.right.map((w) => w.id)).toEqual(['about'])
    expect(l.detail.right.map((w) => w.id)).toEqual(['hot']) // 另一个页面不受影响
  })
})
