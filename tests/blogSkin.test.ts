import { describe, it, expect } from 'vitest'
import {
  defaultSkin,
  parseBlogSkin,
  serializeBlogSkin,
  normalizeHex,
  lighten,
  withAlpha,
  hoverColor,
  applyPreset,
  matchPreset,
  sanitizeCss,
  skinVars,
  SKIN_PRESETS,
  BLOG_SKIN_KEY,
  MAX_CSS_LEN,
  MIN_WIDTH,
  MAX_WIDTH,
  MIN_FONT_SIZE,
  MAX_RADIUS,
} from '../src/lib/blogSkin'

describe('defaultSkin(P12.5)', () => {
  it('默认值逐项等于改造前的外观(不配置则博客页零变化)', () => {
    expect(defaultSkin()).toEqual({
      preset: 'ithome',
      accent: '#d43030',
      accentHover: '#e05252',
      chrome: '#0d0d0d',
      radius: 8, // = Tailwind rounded-lg 的 0.5rem
      font: 'system',
      fontSize: 16,
      width: 1400, // = 原 max-w-[1400px]
      listStyle: 'card',
      css: '',
    })
  })

  it('settings 键名固定', () => {
    expect(BLOG_SKIN_KEY).toBe('blog_skin')
  })
})

describe('parseBlogSkin(容错解析)', () => {
  it('空值/坏 JSON/非对象一律回落默认', () => {
    const def = defaultSkin()
    expect(parseBlogSkin(null)).toEqual(def)
    expect(parseBlogSkin('')).toEqual(def)
    expect(parseBlogSkin('  ')).toEqual(def)
    expect(parseBlogSkin('{坏 json')).toEqual(def)
    expect(parseBlogSkin('"字符串"')).toEqual(def)
    expect(parseBlogSkin('42')).toEqual(def)
  })

  it('单个字段坏掉只回落那一个,其余保留', () => {
    const s = parseBlogSkin(JSON.stringify({ accent: '不是颜色', chrome: '#123456', font: '楷体' }))
    expect(s.accent).toBe('#d43030') // 回落
    expect(s.chrome).toBe('#123456') // 保留
    expect(s.font).toBe('system') // 未知字体回落
  })

  it('数值越界被夹取', () => {
    const s = parseBlogSkin(JSON.stringify({ radius: 999, fontSize: 2, width: 99999 }))
    expect(s.radius).toBe(MAX_RADIUS)
    expect(s.fontSize).toBe(MIN_FONT_SIZE)
    expect(s.width).toBe(MAX_WIDTH)
    expect(parseBlogSkin(JSON.stringify({ width: 10 })).width).toBe(MIN_WIDTH)
  })

  it('悬浮色的空串是合法值(表示跟随主色自动),不该被回落成默认色', () => {
    expect(parseBlogSkin(JSON.stringify({ accentHover: '' })).accentHover).toBe('')
    expect(parseBlogSkin(JSON.stringify({ accentHover: '乱写' })).accentHover).toBe('#e05252')
  })

  it('往返序列化不失真', () => {
    const s = { ...defaultSkin(), accent: '#0f7b6c', accentHover: '', radius: 0, css: 'a{color:red}' }
    expect(parseBlogSkin(serializeBlogSkin(s))).toEqual(s)
  })
})

describe('颜色派生', () => {
  it('normalizeHex:三位补成六位,非法回落', () => {
    expect(normalizeHex('#ABC', '#000000')).toBe('#aabbcc')
    expect(normalizeHex('#D43030', '#000000')).toBe('#d43030')
    expect(normalizeHex('red', '#000000')).toBe('#000000')
    expect(normalizeHex('#12345', '#000000')).toBe('#000000')
    expect(normalizeHex(undefined, '#111111')).toBe('#111111')
  })

  it('lighten 向白色插值,0 与 1 是两端', () => {
    expect(lighten('#000000', 0)).toBe('#000000')
    expect(lighten('#000000', 1)).toBe('#ffffff')
    expect(lighten('#000000', 0.5)).toBe('#808080')
    expect(lighten('#ffffff', 0.5)).toBe('#ffffff')
    // 越界也不炸
    expect(lighten('#000000', -3)).toBe('#000000')
    expect(lighten('#000000', 9)).toBe('#ffffff')
  })

  it('withAlpha 产出现代语法的 rgb()', () => {
    expect(withAlpha('#d43030', 0.07)).toBe('rgb(212 48 48 / 0.07)')
  })

  it('hoverColor:配了用配的,没配就把主色提亮', () => {
    expect(hoverColor({ ...defaultSkin(), accentHover: '#123456' })).toBe('#123456')
    const auto = hoverColor({ ...defaultSkin(), accent: '#000000', accentHover: '' })
    expect(auto).toBe(lighten('#000000', 0.22))
  })
})

describe('预设', () => {
  it('默认皮肤正好等于 ithome 预设', () => {
    expect(matchPreset(defaultSkin())).toBe('ithome')
  })

  it('applyPreset 只换配色,排版设置原样保留', () => {
    const before = { ...defaultSkin(), radius: 2, fontSize: 18, width: 1200, listStyle: 'text' as const, css: 'x{}' }
    const after = applyPreset(before, 'ink')
    expect(after.accent).toBe('#0f7b6c')
    expect(after.accentHover).toBe('') // 交给自动派生
    expect(after.preset).toBe('ink')
    expect(after).toMatchObject({ radius: 2, fontSize: 18, width: 1200, listStyle: 'text', css: 'x{}' })
  })

  it('未知预设 id 原样返回,不改任何东西', () => {
    const s = defaultSkin()
    expect(applyPreset(s, '不存在')).toEqual(s)
  })

  it('手改颜色后不再算作某个预设', () => {
    expect(matchPreset({ ...defaultSkin(), accent: '#123456' })).toBe('custom')
  })

  it('每个预设都能被 matchPreset 认出来(id 与取值一一对应)', () => {
    for (const p of SKIN_PRESETS) {
      expect(matchPreset(applyPreset(defaultSkin(), p.id))).toBe(p.id)
    }
  })
})

describe('sanitizeCss', () => {
  it('去掉闭合 style 标签(防将来改成拼字符串输出时逃逸)', () => {
    expect(sanitizeCss('a{}</style><script>x</script>')).toBe('a{}<script>x</script>')
    expect(sanitizeCss('a{}</ STYLE >b{}')).toBe('a{}b{}')
  })

  it('超长截断', () => {
    expect(sanitizeCss('x'.repeat(MAX_CSS_LEN + 500))).toHaveLength(MAX_CSS_LEN)
  })

  it('空值安全', () => {
    expect(sanitizeCss('')).toBe('')
    expect(sanitizeCss(undefined as any)).toBe('')
  })

  it('解析时也过一道(坏配置存进去了也不生效)', () => {
    expect(parseBlogSkin(JSON.stringify({ css: 'a{}</style>' })).css).toBe('a{}')
  })
})

describe('skinVars', () => {
  it('产出博客根节点要挂的那几个 CSS 变量', () => {
    const v = skinVars(defaultSkin())
    expect(v['--blog-accent']).toBe('#d43030')
    expect(v['--blog-accent-hover']).toBe('#e05252')
    expect(v['--blog-accent-soft']).toBe('rgb(212 48 48 / 0.07)')
    expect(v['--blog-chrome']).toBe('#0d0d0d')
    expect(v['--blog-radius']).toBe('8px')
    expect(v['--blog-fs']).toBe('16px')
    expect(v['--blog-max']).toBe('1400px')
    expect(v['--blog-font']).toContain('system-ui')
  })

  it('悬浮色留空时变量里是派生值,不是空串', () => {
    const v = skinVars({ ...defaultSkin(), accent: '#0f7b6c', accentHover: '' })
    expect(v['--blog-accent-hover']).toBe(lighten('#0f7b6c', 0.22))
  })
})
