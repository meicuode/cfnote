// 主题库(P12.7):把「调好的一套皮肤」存下来、命名、切换、导入导出。
//
// 与 blogSkin.ts 的分工:blogSkin 是**当前生效的那一套**(存 settings.blog_skin,随博客响应下发,
// worker 侧也要用);本文件是**管理端的主题库**(存 settings.blog_skin_library)。
// 分成两个键、两个模块是刻意的——公开博客路径一行都不读主题库,所以攒再多主题也不增加
// D1 查询与响应体积;这个模块也因此不会被打进 worker 包。

import { parseBlogSkin, sanitizeCss, type BlogSkin } from './blogSkin'

export const THEME_LIBRARY_KEY = 'blog_skin_library'
/** 上限只是防止 settings 那一行无限膨胀;个人博客用不到这么多 */
export const MAX_THEMES = 30
export const MAX_THEME_NAME = 40
/** 导出文件的标记,导入时据此拒绝无关的 JSON */
export const THEME_FILE_APP = 'cfnote-blog-theme'
export const THEME_FILE_VERSION = 1

export interface SavedTheme {
  id: string
  name: string
  skin: BlogSkin
}

// ---- 解析 / 序列化 ----

/** 坏值一律回落成空库:主题库是纯展示层配置,任何情况下都不该让配置页打不开 */
export function parseThemeLibrary(raw: string | null | undefined): SavedTheme[] {
  if (!raw) return []
  let arr: unknown
  try {
    arr = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: SavedTheme[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      name: cleanName(o.name, '未命名主题'),
      // 复用皮肤那边已经加固过的解析器,不自己再判一遍字段
      skin: parseBlogSkin(typeof o.skin === 'string' ? o.skin : JSON.stringify(o.skin ?? {})),
    })
    if (out.length >= MAX_THEMES) break
  }
  return out
}

export function serializeThemeLibrary(list: SavedTheme[]): string {
  return JSON.stringify(list.slice(0, MAX_THEMES))
}

function cleanName(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
  return s ? s.slice(0, MAX_THEME_NAME) : fallback
}

// ---- 增删改 ----

/**
 * 下一个 id。取现有 `t<数字>` 的最大值 +1,不用时间戳或随机数——
 * 那样单测就得跟时钟打交道,而这里完全没必要引入不确定性。
 */
export function nextThemeId(list: SavedTheme[]): string {
  let max = 0
  for (const t of list) {
    const m = /^t(\d+)$/.exec(t.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return 't' + (max + 1)
}

/** 重名自动加序号(「墨绿」→「墨绿 2」),而不是拒绝保存——起名撞车是常事,不该打断操作 */
export function uniqueThemeName(list: SavedTheme[], name: string, exceptId?: string): string {
  const base = cleanName(name, '未命名主题')
  const taken = new Set(list.filter((t) => t.id !== exceptId).map((t) => t.name))
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`.slice(0, MAX_THEME_NAME)
    if (!taken.has(candidate)) return candidate
  }
  return base
}

export function addTheme(list: SavedTheme[], name: string, skin: BlogSkin): SavedTheme[] {
  if (list.length >= MAX_THEMES) return list
  return [...list, { id: nextThemeId(list), name: uniqueThemeName(list, name), skin }]
}

/** 把当前配置写回已有主题(省得删了重存) */
export function updateTheme(list: SavedTheme[], id: string, skin: BlogSkin): SavedTheme[] {
  return list.map((t) => (t.id === id ? { ...t, skin } : t))
}

export function renameTheme(list: SavedTheme[], id: string, name: string): SavedTheme[] {
  return list.map((t) => (t.id === id ? { ...t, name: uniqueThemeName(list, name, id) } : t))
}

export function removeTheme(list: SavedTheme[], id: string): SavedTheme[] {
  return list.filter((t) => t.id !== id)
}

export function findTheme(list: SavedTheme[], id: string): SavedTheme | null {
  return list.find((t) => t.id === id) ?? null
}

// ---- 导入 / 导出 ----

/**
 * 导出的是一份配置 JSON,不是 WordPress 那种含模板的主题包——我们的「主题」本来就只有
 * 配色、排版与额外 CSS 这几项值,叫「主题配置」更诚实。
 */
export function exportThemeJson(t: SavedTheme): string {
  return JSON.stringify({ app: THEME_FILE_APP, version: THEME_FILE_VERSION, name: t.name, skin: t.skin }, null, 2)
}

/** 文件名里去掉路径分隔符等,避免下载时出怪文件名 */
export function themeFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'theme'
  return `cfnote-theme-${safe}.json`
}

/**
 * 额外 CSS 里的外部引用。
 *
 * CSS 不能执行 JS,但能把访客的 IP 与 Referer 送到第三方:`@import url(https://…)` 一定会发请求,
 * `url(https://…)` 的背景图同理。自己写的 CSS 里这么干是本人的选择,**从别人那里导入的就不是了**。
 * 故导入时:`@import` 直接剥掉(它的唯一用途就是拉远程样式表),外部 `url()` 保留但列出来让人过一眼——
 * 有人确实会用 CDN 上的背景图,一刀切删掉等于让导入的主题静默走样。
 */
export function stripRemoteCss(css: string): { css: string; imports: number; urls: string[] } {
  const src = String(css || '')
  let imports = 0
  const cleaned = src.replace(/@import\s+[^;]*;?/gi, () => {
    imports++
    return ''
  })
  const urls: string[] = []
  const re = /url\(\s*['"]?(https?:\/\/[^)'"\s]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) {
    if (!urls.includes(m[1])) urls.push(m[1])
    if (urls.length >= 10) break
  }
  return { css: cleaned, imports, urls }
}

export type ImportResult =
  | { ok: true; name: string; skin: BlogSkin; warnings: string[] }
  | { ok: false; error: string }

export function parseImportedTheme(text: string): ImportResult {
  let o: any
  try {
    o = JSON.parse(String(text || ''))
  } catch {
    return { ok: false, error: '不是合法的 JSON 文件' }
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, error: '文件内容不是一个主题对象' }
  if (o.app !== THEME_FILE_APP) return { ok: false, error: '这不是 CFNote 导出的主题文件' }
  if (o.skin == null || typeof o.skin !== 'object') return { ok: false, error: '文件里没有主题配置' }

  // 一律过一遍皮肤解析器:字段缺失、类型不对、颜色非法都在那里回落,不信任外来 blob 的任何一项
  const skin = parseBlogSkin(JSON.stringify(o.skin))
  const warnings: string[] = []
  const { css, imports, urls } = stripRemoteCss(skin.css)
  if (imports > 0) warnings.push(`已移除 ${imports} 条 @import(会把访客的 IP 与来源发给第三方)`)
  if (urls.length > 0) warnings.push(`额外 CSS 里引用了外部地址,请自行确认:${urls.join('、')}`)

  return {
    ok: true,
    name: cleanName(o.name, '导入的主题'),
    skin: { ...skin, css: sanitizeCss(css) },
    warnings,
  }
}
