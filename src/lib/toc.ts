// 章节目录(P11.8):把正文标题文本转成稳定的 URL 片段 id,供左侧浮层目录跳转
// 与「复制 /blog/12#部署步骤 分享到某一节」使用。与评论锚点 #comment-<id> 共用一套 hash 处理,互不冲突。
//
// 纯函数,不碰 DOM(标题扫描留给组件),便于单测。

export interface TocItem {
  /** 片段 id(已去重) */
  id: string
  text: string
  /** 1~3,对应 h1/h2/h3 */
  level: number
}

/** 少于这么多标题就不显示目录——短文挂目录纯属噪音 */
export const MIN_TOC_HEADINGS = 3

/**
 * 标题文本 → id 片段:保留中英文与数字,空白转 `-`,其余标点丢弃(中文标题因此原样保留,可读性好)。
 * `used` 传入时做重名去重(第二个同名标题拿 `-2`,以此类推),并把结果登记进去。
 */
export function slugifyHeading(text: string, used?: Set<string>): string {
  const base =
    (text || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}\-_]/gu, '')
      .replace(/-{2,}/g, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  if (!used) return base
  let slug = base
  let n = 2
  while (used.has(slug)) slug = `${base}-${n++}`
  used.add(slug)
  return slug
}

/** 相对缩进层级:整篇最浅的标题算第 0 层(全篇都是 h2 时不会白缩进一格) */
export function tocIndent(item: TocItem, items: TocItem[]): number {
  const min = items.reduce((m, t) => Math.min(m, t.level), 6)
  return Math.max(0, item.level - min)
}
