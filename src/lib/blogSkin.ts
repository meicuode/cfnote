// 博客皮肤(P12.5):配色与排版。与 blogTheme.ts 分工——
//   blogTheme.ts = 访客侧的**明暗模式偏好**(跟随系统 / 手动切换,存 localStorage)
//   blogSkin.ts  = 博主侧的**皮肤配置**(主色、顶栏色、圆角、字体、字号、容器宽度、列表样式、额外 CSS),
//                  存 settings.blog_skin,随博客接口下发,明暗两套配色共用同一份皮肤。
//
// 为什么只给这几个旋钮而不是把十几个 --blog-* 全放出来:中性色(卡片/边框/正文灰)是成对调过的
// 明暗值,单独改一个很容易配出读不了的组合;而主色 + 顶栏色一换,logo、链接、热榜序号、按钮、
// 顶栏页脚全跟着变,观感上就是另一套主题了。需要精细控制的场景交给「额外 CSS」。

export const BLOG_SKIN_KEY = 'blog_skin'

export type FontKey = 'system' | 'serif' | 'mono'
export const FONT_LABELS: Record<FontKey, string> = {
  system: '系统默认(无衬线)',
  serif: '衬线(长文更耐读)',
  mono: '等宽',
}
export const FONT_STACKS: Record<FontKey, string> = {
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'ui-serif, Georgia, Cambria, "Songti SC", "Noto Serif CJK SC", serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
}

export type ListStyle = 'card' | 'text'
export const LIST_STYLE_LABELS: Record<ListStyle, string> = {
  card: '左图右文(默认)',
  text: '纯文字列表(不加载缩略图)',
}

export const MIN_RADIUS = 0
export const MAX_RADIUS = 20
export const MIN_FONT_SIZE = 15
export const MAX_FONT_SIZE = 20
export const MIN_WIDTH = 1100
export const MAX_WIDTH = 1600
/** 额外 CSS 的长度上限:够写几十条规则,又不至于把 settings 行撑爆 */
export const MAX_CSS_LEN = 8000

export interface BlogSkin {
  /** 预设 id;改过任意颜色后置为 'custom' */
  preset: string
  accent: string
  /** 悬浮/强调色;留空则由 accent 自动提亮 */
  accentHover: string
  /** 顶栏与页脚底色 */
  chrome: string
  radius: number
  font: FontKey
  fontSize: number
  width: number
  listStyle: ListStyle
  css: string
}

export interface SkinPreset {
  id: string
  name: string
  accent: string
  chrome: string
}

// 预设只动主色与顶栏色:这两项一换观感就是另一套主题,而中性色维持调好的明暗配对
export const SKIN_PRESETS: SkinPreset[] = [
  { id: 'ithome', name: 'IT之家红(默认)', accent: '#d43030', chrome: '#0d0d0d' },
  { id: 'ink', name: '墨绿', accent: '#0f7b6c', chrome: '#10221f' },
  { id: 'azure', name: '深蓝', accent: '#1f6feb', chrome: '#0b1220' },
  { id: 'plum', name: '酒紫', accent: '#8250df', chrome: '#16101f' },
  { id: 'graphite', name: '石墨(极简)', accent: '#4b5563', chrome: '#1f2937' },
]

/** 默认皮肤 = 今天的样子,逐项对齐(radius 8 = Tailwind 的 rounded-lg,width 1400 = 原 max-w-[1400px]) */
export function defaultSkin(): BlogSkin {
  return {
    preset: 'ithome',
    accent: '#d43030',
    accentHover: '#e05252',
    chrome: '#0d0d0d',
    radius: 8,
    font: 'system',
    fontSize: 16,
    width: 1400,
    listStyle: 'card',
    css: '',
  }
}

// ---- 颜色工具(纯函数,可单测)----

/** #abc / #aabbcc → 规范化的 #aabbcc;非法值回落 fallback */
export function normalizeHex(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase()
  if (/^#[0-9a-f]{3}$/i.test(s)) return ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase()
  return fallback
}

function toRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex, '#000000')
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
}

/** 向白色插值 pct(0–1);用于从主色派生悬浮色,省得让人填两个颜色 */
export function lighten(hex: string, pct: number): string {
  const p = Math.max(0, Math.min(1, pct))
  const v = toRgb(hex).map((c) => Math.round(c + (255 - c) * p))
  return '#' + v.map((c) => c.toString(16).padStart(2, '0')).join('')
}

/** 主色的极淡底色(引用块背景一类) */
export function withAlpha(hex: string, a: number): string {
  const [r, g, b] = toRgb(hex)
  return `rgb(${r} ${g} ${b} / ${a})`
}

/** 悬浮色:配了就用配的,没配就把主色提亮一档 */
export function hoverColor(s: BlogSkin): string {
  return s.accentHover ? s.accentHover : lighten(s.accent, 0.22)
}

// ---- 解析与序列化 ----

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * settings 里的字符串 → 皮肤。与布局同样的原则:任何坏值都回落默认,
 * 皮肤配置绝不该有能力让博客页打不开或变成看不清的样子。
 */
export function parseBlogSkin(raw: string | null | undefined): BlogSkin {
  const def = defaultSkin()
  if (!raw || !raw.trim()) return def
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return def
  }
  if (!data || typeof data !== 'object') return def
  const o = data as Record<string, unknown>
  const font = o.font === 'serif' || o.font === 'mono' || o.font === 'system' ? o.font : def.font
  const listStyle = o.listStyle === 'text' || o.listStyle === 'card' ? o.listStyle : def.listStyle
  return {
    preset: typeof o.preset === 'string' && o.preset ? o.preset : def.preset,
    accent: normalizeHex(o.accent, def.accent),
    // 空串是合法值(表示自动派生),故不走 normalizeHex 的回落
    accentHover: typeof o.accentHover === 'string' && o.accentHover.trim() === '' ? '' : normalizeHex(o.accentHover, def.accentHover),
    chrome: normalizeHex(o.chrome, def.chrome),
    radius: clampNum(o.radius, MIN_RADIUS, MAX_RADIUS, def.radius),
    font,
    fontSize: clampNum(o.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, def.fontSize),
    width: clampNum(o.width, MIN_WIDTH, MAX_WIDTH, def.width),
    listStyle,
    css: sanitizeCss(typeof o.css === 'string' ? o.css : ''),
  }
}

export function serializeBlogSkin(s: BlogSkin): string {
  return JSON.stringify(s)
}

/**
 * 额外 CSS 的清洗。内容由博主自己撰写(与自定义 Markdown 模块同等信任),
 * 这里只做两件事:截断长度、去掉 `</style` ——
 * 我们是用 React 往 <style> 塞 textContent,本就不会被 HTML 解析器重新解析,
 * 但万一将来改成拼字符串输出,这一道能挡住闭合标签逃逸。
 */
export function sanitizeCss(css: string): string {
  return (css || '').replace(/<\/\s*style\s*>?/gi, '').slice(0, MAX_CSS_LEN)
}

/** 套用预设:只改主色与顶栏色,排版设置保留 */
export function applyPreset(s: BlogSkin, id: string): BlogSkin {
  const p = SKIN_PRESETS.find((x) => x.id === id)
  if (!p) return s
  return { ...s, preset: p.id, accent: p.accent, accentHover: '', chrome: p.chrome }
}

/** 改了任意颜色就不再算「某个预设」,除非正好等于某个预设的取值 */
export function matchPreset(s: BlogSkin): string {
  const hit = SKIN_PRESETS.find((p) => p.accent === s.accent && p.chrome === s.chrome)
  return hit ? hit.id : 'custom'
}

/** 皮肤 → 挂在博客根节点上的 CSS 变量(内联,优先级高于 index.css 里的同名默认值) */
export function skinVars(s: BlogSkin): Record<string, string> {
  const hover = hoverColor(s)
  return {
    '--blog-accent': s.accent,
    '--blog-accent-hover': hover,
    '--blog-accent-soft': withAlpha(s.accent, 0.07),
    '--blog-chrome': s.chrome,
    '--blog-radius': `${s.radius}px`,
    '--blog-font': FONT_STACKS[s.font],
    '--blog-fs': `${s.fontSize}px`,
    '--blog-max': `${s.width}px`,
  }
}
