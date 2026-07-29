import { describe, it, expect } from 'vitest'
import {
  MAX_THEMES, MAX_THEME_NAME, THEME_FILE_APP,
  parseThemeLibrary, serializeThemeLibrary, nextThemeId, uniqueThemeName,
  addTheme, updateTheme, renameTheme, removeTheme, findTheme,
  exportThemeJson, themeFileName, stripRemoteCss, parseImportedTheme,
  type SavedTheme,
} from '../src/lib/blogThemes'
import { defaultSkin, MAX_RADIUS } from '../src/lib/blogSkin'

const mk = (id: string, name: string, accent = '#d43030'): SavedTheme => ({
  id, name, skin: { ...defaultSkin(), accent },
})

describe('parseThemeLibrary', () => {
  it('空值与坏 JSON 回落成空库', () => {
    expect(parseThemeLibrary('')).toEqual([])
    expect(parseThemeLibrary(null)).toEqual([])
    expect(parseThemeLibrary('{oops')).toEqual([])
    // 不是数组也不该崩
    expect(parseThemeLibrary('{"a":1}')).toEqual([])
  })

  it('丢掉没有 id 的项与重复 id', () => {
    const raw = JSON.stringify([
      { id: 't1', name: 'A', skin: {} },
      { name: '没有 id', skin: {} },
      { id: 't1', name: '重复', skin: {} },
    ])
    const l = parseThemeLibrary(raw)
    expect(l).toHaveLength(1)
    expect(l[0].id).toBe('t1')
  })

  it('皮肤字段一律过 parseBlogSkin,非法值回落默认', () => {
    const l = parseThemeLibrary(JSON.stringify([{ id: 't1', name: 'A', skin: { accent: '不是颜色', radius: 999 } }]))
    expect(l[0].skin.accent).toBe(defaultSkin().accent)
    expect(l[0].skin.radius).toBeLessThanOrEqual(MAX_RADIUS)
  })

  it('缺名字给个占位,超长截断', () => {
    const long = 'x'.repeat(200)
    const l = parseThemeLibrary(JSON.stringify([{ id: 't1', skin: {} }, { id: 't2', name: long, skin: {} }]))
    expect(l[0].name).toBe('未命名主题')
    expect(l[1].name).toHaveLength(MAX_THEME_NAME)
  })

  it('超过上限的部分被丢弃', () => {
    const many = Array.from({ length: MAX_THEMES + 5 }, (_, i) => ({ id: 't' + i, name: 'n' + i, skin: {} }))
    expect(parseThemeLibrary(JSON.stringify(many))).toHaveLength(MAX_THEMES)
  })

  it('序列化后能原样读回', () => {
    const l = [mk('t1', '墨绿', '#0f7b6c')]
    const back = parseThemeLibrary(serializeThemeLibrary(l))
    expect(back[0].name).toBe('墨绿')
    expect(back[0].skin.accent).toBe('#0f7b6c')
  })
})

describe('id 与重名', () => {
  it('id 取现有最大值 +1,不依赖时钟或随机数', () => {
    expect(nextThemeId([])).toBe('t1')
    expect(nextThemeId([mk('t1', 'a'), mk('t7', 'b')])).toBe('t8')
    // 非 t<数字> 形态的 id(比如导入的旧数据)不参与计算,也不该让它算出 NaN
    expect(nextThemeId([mk('abc', 'a')])).toBe('t1')
  })

  it('重名自动加序号而不是拒绝保存', () => {
    const l = [mk('t1', '墨绿')]
    expect(uniqueThemeName(l, '墨绿')).toBe('墨绿 2')
    expect(uniqueThemeName([...l, mk('t2', '墨绿 2')], '墨绿')).toBe('墨绿 3')
    // 改自己的名字时不该跟自己撞
    expect(uniqueThemeName(l, '墨绿', 't1')).toBe('墨绿')
  })
})

describe('增删改', () => {
  const base = [mk('t1', '墨绿', '#0f7b6c')]

  it('addTheme 追加并分配新 id', () => {
    const l = addTheme(base, '深蓝', { ...defaultSkin(), accent: '#1f6feb' })
    expect(l).toHaveLength(2)
    expect(l[1].id).toBe('t2')
    expect(l[1].skin.accent).toBe('#1f6feb')
  })

  it('addTheme 到上限后不再增加(静默保持原样,由 UI 提示)', () => {
    const full = Array.from({ length: MAX_THEMES }, (_, i) => mk('t' + (i + 1), 'n' + i))
    expect(addTheme(full, '再来一个', defaultSkin())).toHaveLength(MAX_THEMES)
  })

  it('updateTheme 只改中招那一项的 skin,名字不动', () => {
    const l = updateTheme(base, 't1', { ...defaultSkin(), accent: '#000000' })
    expect(l[0].name).toBe('墨绿')
    expect(l[0].skin.accent).toBe('#000000')
  })

  it('renameTheme / removeTheme / findTheme', () => {
    expect(renameTheme(base, 't1', '新名字')[0].name).toBe('新名字')
    expect(removeTheme(base, 't1')).toEqual([])
    expect(removeTheme(base, '不存在')).toHaveLength(1)
    expect(findTheme(base, 't1')?.name).toBe('墨绿')
    expect(findTheme(base, 'nope')).toBeNull()
  })
})

describe('stripRemoteCss', () => {
  it('剥掉 @import(它唯一的用途就是拉远程样式表)', () => {
    const r = stripRemoteCss('@import url(https://evil.com/a.css); a{color:red}')
    expect(r.css).not.toContain('@import')
    expect(r.css).toContain('a{color:red}')
    expect(r.imports).toBe(1)
  })

  it('外部 url() 保留但列出来让人过一眼', () => {
    const r = stripRemoteCss('body{background:url("https://cdn.example.com/bg.png")}')
    expect(r.css).toContain('cdn.example.com')
    expect(r.urls).toEqual(['https://cdn.example.com/bg.png'])
  })

  it('站内相对路径不算外部引用', () => {
    expect(stripRemoteCss('body{background:url(/api/files/bg.png)}').urls).toEqual([])
  })
})

describe('导入导出', () => {
  const t = mk('t1', '墨绿', '#0f7b6c')

  it('导出再导入能还原配色', () => {
    const r = parseImportedTheme(exportThemeJson(t))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.name).toBe('墨绿')
    expect(r.skin.accent).toBe('#0f7b6c')
    expect(r.warnings).toEqual([])
  })

  it('拒绝非主题文件', () => {
    expect(parseImportedTheme('不是 json')).toMatchObject({ ok: false })
    expect(parseImportedTheme('{"app":"别的应用"}')).toMatchObject({ ok: false })
    expect(parseImportedTheme(JSON.stringify({ app: THEME_FILE_APP }))).toMatchObject({ ok: false })
    // 数组也不是主题对象
    expect(parseImportedTheme('[]')).toMatchObject({ ok: false })
  })

  it('外来 blob 的非法字段被 parseBlogSkin 兜住,而不是原样收下', () => {
    const r = parseImportedTheme(JSON.stringify({ app: THEME_FILE_APP, name: 'X', skin: { accent: 'javascript:x', width: -5 } }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skin.accent).toBe(defaultSkin().accent)
    expect(r.skin.width).toBeGreaterThan(0)
  })

  it('导入时剥掉 @import 并给出提示', () => {
    const r = parseImportedTheme(JSON.stringify({
      app: THEME_FILE_APP, name: 'X', skin: { css: '@import url(https://evil.com/a.css); a{color:red}' },
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skin.css).not.toContain('@import')
    expect(r.warnings.join()).toContain('@import')
  })

  it('导入的额外 CSS 仍走 sanitizeCss(拼字符串输出时 </style> 能逃逸)', () => {
    const r = parseImportedTheme(JSON.stringify({
      app: THEME_FILE_APP, name: 'X', skin: { css: 'a{}</style><script>alert(1)</script>' },
    }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.skin.css).not.toContain('</style>')
  })

  it('文件名里的路径分隔符被替换', () => {
    expect(themeFileName('a/b:c')).toBe('cfnote-theme-a_b_c.json')
    expect(themeFileName('   ')).toBe('cfnote-theme-theme.json')
  })
})
