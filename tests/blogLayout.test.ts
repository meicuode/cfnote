import { describe, it, expect } from 'vitest'
import {
  defaultLayout,
  parseBlogLayout,
  serializeBlogLayout,
  enabledWidgets,
  hasSide,
  contentWidth,
  clampWidth,
  parseLinks,
  toggleWidget,
  updateWidget,
  updatePageSettings,
  moveWidget,
  locateWidget,
  addWidget,
  removeWidget,
  defaultMenu,
  menuHref,
  usableMenu,
  addMenuItem,
  updateMenuItem,
  removeMenuItem,
  moveMenuItem,
  pageUsesWidget,
  maxWidgetOption,
  firstWidgetOption,
  parseBannerBg,
  widgetChoices,
  widgetWorksOn,
  DETAIL_ONLY_WIDGETS,
  BLOG_LAYOUT_KEY,
  MIN_SIDE_WIDTH,
  MAX_SIDE_WIDTH,
  CONTENT_WARN_BELOW,
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

  it('默认布局等于模块化之前的样子:列表页右栏热榜+关于本站,详情页右栏只有热榜', () => {
    const def = defaultLayout()
    expect(def.list.right.map((w) => w.type)).toEqual(['hot', 'about'])
    expect(def.detail.right.map((w) => w.type)).toEqual(['hot'])
    expect(def.list.top).toEqual([])
    expect(def.list.left).toEqual([])
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

describe('侧栏宽度与窄屏降级(P12.2)', () => {
  it('宽度夹到 [200,420],非数字回落', () => {
    expect(clampWidth(10, 300)).toBe(MIN_SIDE_WIDTH)
    expect(clampWidth(9999, 300)).toBe(MAX_SIDE_WIDTH)
    expect(clampWidth('320', 300)).toBe(320)
    expect(clampWidth('abc', 300)).toBe(300)
    expect(clampWidth(undefined, 300)).toBe(300)
  })

  it('解析时越界宽度被夹取,非法 narrow 回落默认', () => {
    const l = parseBlogLayout(JSON.stringify({
      list: { right: [], leftWidth: 5, rightWidth: 5000, narrow: '乱写' },
      detail: {},
    }))
    expect(l.list.leftWidth).toBe(MIN_SIDE_WIDTH)
    expect(l.list.rightWidth).toBe(MAX_SIDE_WIDTH)
    expect(l.list.narrow).toBe('bottom')
  })

  it('hasSide 只认「有启用模块」的侧栏', () => {
    const def = defaultLayout()
    expect(hasSide(def.list, 'right')).toBe(true)
    expect(hasSide(def.list, 'left')).toBe(false)
    const off = toggleWidget(toggleWidget(def, 'list', 'hot'), 'list', 'about')
    expect(hasSide(off.list, 'right')).toBe(false)
  })

  it('contentWidth:只右栏 380 时正文约 952,左右同开会跌破警告线', () => {
    const def = defaultLayout()
    expect(contentWidth(def.list)).toBe(1400 - 40 - 380 - 28) // 952
    let l = addWidget(def, 'list', 'left', 'tags')
    l = updatePageSettings(l, 'list', { leftWidth: 300 })
    expect(contentWidth(l.list)).toBe(1400 - 40 - 380 - 28 - 300 - 28) // 624
    expect(contentWidth(l.list)).toBeLessThan(CONTENT_WARN_BELOW)
  })

  it('两侧都空时正文吃满容器', () => {
    const empty = parseBlogLayout(JSON.stringify({ list: {}, detail: {} }))
    expect(contentWidth(empty.list)).toBe(1360)
  })

  it('updatePageSettings 夹取宽度且不动模块', () => {
    const l = updatePageSettings(defaultLayout(), 'list', { leftWidth: 9999, narrow: 'top' })
    expect(l.list.leftWidth).toBe(MAX_SIDE_WIDTH)
    expect(l.list.narrow).toBe('top')
    expect(l.list.right.map((w) => w.id)).toEqual(['hot', 'about'])
  })
})

describe('parseLinks(友情链接,P12.2)', () => {
  it('一行一条「名称|URL」', () => {
    expect(parseLinks('CF|https://cloudflare.com\n本站|/blog')).toEqual([
      { name: 'CF', url: 'https://cloudflare.com' },
      { name: '本站', url: '/blog' },
    ])
  })

  it('丢弃空行、缺分隔、缺名称或缺 URL 的行', () => {
    expect(parseLinks('\n  \n没有分隔符\n|只有url\nname|')).toEqual([])
  })

  it('挡掉 javascript: 一类的 URL(只放行 http(s) 与站内相对路径)', () => {
    expect(parseLinks('坏|javascript:alert(1)\n坏2|data:text/html,x\n好|https://a.com')).toEqual([
      { name: '好', url: 'https://a.com' },
    ])
  })

  it('空配置返回空数组', () => {
    expect(parseLinks(undefined)).toEqual([])
    expect(parseLinks('')).toEqual([])
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

  it('moveWidget 跨槽位移动(含左栏),页面级设置不丢', () => {
    const l = moveWidget(updatePageSettings(defaultLayout(), 'list', { leftWidth: 260 }), 'list', 'about', 'left', 0)
    expect(l.list.right.map((w) => w.id)).toEqual(['hot'])
    expect(l.list.left.map((w) => w.id)).toEqual(['about'])
    expect(l.list.leftWidth).toBe(260)
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

  it('addWidget 追加到槽位末尾并生成唯一 id,带上该类型的初始配置', () => {
    let l = addWidget(defaultLayout(), 'list', 'top', 'hot')
    expect(l.list.top.map((w) => w.id)).toEqual(['hot-2']) // 'hot' 已被右栏占用
    l = addWidget(l, 'list', 'top', 'recent')
    expect(l.list.top[1].options.count).toBe('8')
    expect(l.list.top[1].title).toBe('最新文章')
  })

  it('removeWidget 删除并保留其余', () => {
    const l = removeWidget(defaultLayout(), 'list', 'hot')
    expect(l.list.right.map((w) => w.id)).toEqual(['about'])
    expect(l.detail.right.map((w) => w.id)).toEqual(['hot']) // 另一个页面不受影响
  })
})

describe('按布局装配数据(P12.3):worker 据此决定下发哪几份', () => {
  it('pageUsesWidget 只认启用的模块', () => {
    const def = defaultLayout()
    expect(pageUsesWidget(def.list, 'hot')).toBe(true)
    expect(pageUsesWidget(def.list, 'recent')).toBe(false)
    expect(pageUsesWidget(def.detail, 'about')).toBe(false)
    // 停用后不再需要下发对应数据
    expect(pageUsesWidget(toggleWidget(def, 'list', 'hot').list, 'hot')).toBe(false)
  })

  it('pageUsesWidget 跨四个槽位都算', () => {
    const l = addWidget(defaultLayout(), 'detail', 'bottom', 'tags')
    expect(pageUsesWidget(l.detail, 'tags')).toBe(true)
  })

  it('maxWidgetOption 取同类模块里最大的条数(放了两个「最新文章」就按大的拉)', () => {
    let l = addWidget(defaultLayout(), 'list', 'left', 'recent')
    l = updateWidget(l, 'list', 'recent', { options: { count: '5' } })
    expect(maxWidgetOption(l.list, 'recent', 'count', 8)).toBe(5)
    l = addWidget(l, 'list', 'bottom', 'recent')
    l = updateWidget(l, 'list', 'recent-2', { options: { count: '12' } })
    expect(maxWidgetOption(l.list, 'recent', 'count', 8)).toBe(12)
    // 一个都没有时用兜底值
    expect(maxWidgetOption(defaultLayout().list, 'recent', 'count', 8)).toBe(8)
  })
})

describe('导航菜单(P12.3)', () => {  it('默认只有一个「首页」,等于改造前的顶栏', () => {
    expect(defaultMenu()).toEqual([{ id: 'home', type: 'home', label: '首页', value: '' }])
    expect(defaultLayout().menu).toEqual(defaultMenu())
  })

  it('menuHref:各类型的链接形态', () => {
    expect(menuHref({ id: 'a', type: 'home', label: '首页', value: '' })).toBe('/blog')
    expect(menuHref({ id: 'b', type: 'tag', label: '运维', value: '运维' })).toBe('/blog?tag=%E8%BF%90%E7%BB%B4')
    expect(menuHref({ id: 'c', type: 'page', label: '关于', value: '12' })).toBe('/blog/12')
    expect(menuHref({ id: 'd', type: 'link', label: 'CF', value: 'https://a.com' })).toBe('https://a.com')
    expect(menuHref({ id: 'e', type: 'link', label: '站内', value: '/clip' })).toBe('/clip')
  })

  it('menuHref:配置不完整或不安全的返回 null(不渲染成死链)', () => {
    expect(menuHref({ id: 'a', type: 'tag', label: 'x', value: '  ' })).toBeNull()
    expect(menuHref({ id: 'b', type: 'page', label: 'x', value: '不是数字' })).toBeNull()
    expect(menuHref({ id: 'c', type: 'page', label: 'x', value: '0' })).toBeNull()
    expect(menuHref({ id: 'd', type: 'link', label: 'x', value: 'javascript:alert(1)' })).toBeNull()
    expect(menuHref({ id: 'e', type: 'link', label: 'x', value: '' })).toBeNull()
  })

  it('usableMenu 过滤掉不可用项', () => {
    const menu = [
      { id: 'a', type: 'home' as const, label: '首页', value: '' },
      { id: 'b', type: 'tag' as const, label: '空标签', value: '' },
      { id: 'c', type: 'link' as const, label: '坏链', value: 'javascript:x' },
      { id: 'd', type: 'page' as const, label: '关于', value: '7' },
    ]
    expect(usableMenu(menu).map((x) => x.href)).toEqual(['/blog', '/blog/7'])
  })

  it('解析容错:不是数组、类型不认识、缺字段都不会炸', () => {
    // 坏成非数组 → 回落默认菜单(顶栏不该因为配置坏了就没有导航);显式空数组才是「我就要没有菜单」
    expect(parseBlogLayout(JSON.stringify({ list: {}, menu: 'oops' })).menu).toEqual(defaultMenu())
    expect(parseBlogLayout(JSON.stringify({ list: {}, menu: [] })).menu).toEqual([])
    const l = parseBlogLayout(JSON.stringify({
      list: {},
      menu: [{ type: '不存在' }, { type: 'tag', value: '运维' }, null, { type: 'home' }],
    }))
    expect(l.menu.map((m) => m.type)).toEqual(['tag', 'home'])
    expect(l.menu[0].label).toBe('标签 / 笔记本') // 没写 label 就回落类型默认名
    expect(l.menu[0].id).toBeTruthy()
  })

  it('只配了菜单时,两个页面布局仍是默认值(不会变成空白页)', () => {
    const l = parseBlogLayout(JSON.stringify({ menu: [{ type: 'home', label: '首页' }] }))
    expect(l.list.right.map((w) => w.type)).toEqual(['hot', 'about'])
    expect(l.detail.right.map((w) => w.type)).toEqual(['hot'])
  })

  it('增删改排序都是不可变操作', () => {
    const base = defaultLayout()
    let l = addMenuItem(base, 'tag')
    expect(l.menu.map((m) => m.id)).toEqual(['home', 'tag'])
    expect(base.menu).toHaveLength(1) // 入参没被改

    l = updateMenuItem(l, 'tag', { label: '运维', value: '运维', id: '篡改' } as any)
    expect(l.menu[1]).toMatchObject({ id: 'tag', label: '运维', value: '运维' })

    l = addMenuItem(l, 'tag')
    expect(l.menu.map((m) => m.id)).toEqual(['home', 'tag', 'tag-2'])

    l = moveMenuItem(l, 'tag-2', -2)
    expect(l.menu.map((m) => m.id)).toEqual(['tag-2', 'home', 'tag'])
    expect(moveMenuItem(l, 'tag-2', -1)).toEqual(l) // 越界原样返回
    expect(moveMenuItem(l, '不存在', 1)).toEqual(l)

    l = removeMenuItem(l, 'home')
    expect(l.menu.map((m) => m.id)).toEqual(['tag-2', 'tag'])
  })

  it('菜单跟着布局一起往返序列化', () => {
    const l = updateMenuItem(addMenuItem(defaultLayout(), 'link'), 'link', { label: 'CF', value: 'https://a.com' })
    expect(parseBlogLayout(serializeBlogLayout(l))).toEqual(l)
  })
})

describe('顶部/底部模块(P12.4)', () => {
  it('五个新类型能解析、能往返,旧配置不受影响', () => {
    let l = defaultLayout()
    for (const t of ['slider', 'banner', 'postgrid'] as const) l = addWidget(l, 'list', 'top', t)
    l = addWidget(l, 'detail', 'bottom', 'prevnext')
    l = addWidget(l, 'detail', 'bottom', 'related')
    expect(parseBlogLayout(serializeBlogLayout(l))).toEqual(l)
    expect(l.list.top.map((w) => w.type)).toEqual(['slider', 'banner', 'postgrid'])
  })

  it('新模块自带合理的初始配置(幻灯片默认 5 张、自动播放)', () => {
    const l = addWidget(defaultLayout(), 'list', 'top', 'slider')
    expect(l.list.top[0].options).toMatchObject({ source: 'recent', count: '5', auto: '1', height: 'md' })
    const b = addWidget(defaultLayout(), 'list', 'top', 'banner')
    expect(b.list.top[0].options.dismissible).toBe('0') // 默认不可关闭;勾上 + 矮高度就是公告条
  })

  it('「上一篇/下一篇」「相关文章」只在详情页成立', () => {
    expect(DETAIL_ONLY_WIDGETS).toEqual(['prevnext', 'related'])
    expect(widgetWorksOn('prevnext', 'list')).toBe(false)
    expect(widgetWorksOn('prevnext', 'detail')).toBe(true)
    expect(widgetWorksOn('slider', 'list')).toBe(true)
  })

  it('添加菜单按槽位分「常用 / 其他」,且列表页不列详情页专用的', () => {
    const top = widgetChoices('top', 'list')
    expect(top.common).toContain('slider')
    expect(top.common).toContain('banner')
    expect(top.common).not.toContain('hot') // 热榜是侧栏货色
    expect([...top.common, ...top.others]).not.toContain('related')

    const bottom = widgetChoices('bottom', 'detail')
    expect(bottom.common).toEqual(expect.arrayContaining(['prevnext', 'related', 'postgrid']))

    // 两组加起来 = 该页可用的全部类型,不重不漏
    const all = [...bottom.common, ...bottom.others]
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(12)
  })

  it('firstWidgetOption 取第一个启用实例的取数来源', () => {
    let l = addWidget(defaultLayout(), 'list', 'top', 'slider')
    expect(firstWidgetOption(l.list, 'slider', 'source', 'recent')).toBe('recent')
    l = updateWidget(l, 'list', 'slider', { options: { source: 'hot' } })
    expect(firstWidgetOption(l.list, 'slider', 'source', 'recent')).toBe('hot')
    // 停用的不算
    l = toggleWidget(l, 'list', 'slider')
    expect(firstWidgetOption(l.list, 'slider', 'source', 'recent')).toBe('recent')
  })

  it('parseBannerBg:只放行图片 URL 与规范颜色,其余回落默认渐变', () => {
    expect(parseBannerBg('https://a.com/x.jpg')).toEqual({ kind: 'image', value: 'https://a.com/x.jpg' })
    expect(parseBannerBg('/api/files/u1/abc/x.png')).toEqual({ kind: 'image', value: '/api/files/u1/abc/x.png' })
    expect(parseBannerBg('#1f6feb')).toEqual({ kind: 'color', value: '#1f6feb' })
    expect(parseBannerBg('rgba(0, 0, 0, .5)')).toEqual({ kind: 'color', value: 'rgba(0, 0, 0, .5)' })
    expect(parseBannerBg('')).toEqual({ kind: 'none', value: '' })
    expect(parseBannerBg(undefined)).toEqual({ kind: 'none', value: '' })
    // 挡掉能拉外部资源或塞进任意 CSS 的写法
    expect(parseBannerBg('url(javascript:alert(1))').kind).toBe('none')
    expect(parseBannerBg('red; background-image: url(http://evil/x)').kind).toBe('none')
    expect(parseBannerBg('image-set("http://evil/x")').kind).toBe('none')
  })
})
