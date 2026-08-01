// 博客文章的 URL slug(P15.2):`/blog/12` → `/blog/12/部署-cloudflare-workers`。
//
// **id 在前、slug 装饰**,不是 `/blog/部署-cloudflare-workers`。这个形态的红利是决定性的:
// 查表永远只认 id,所以改标题不会断链、不需要唯一约束、不需要冲突处理、不需要迁移;
// `wrangler.toml` 的 `run_worker_first = /blog/*` 照样匹配;客户端那条 `^/blog/(\d+)` 是
// 前缀匹配,多一个路径段本来就能解析。
//
// **slug 从标题现算,不存库**:id-first 之下 slug 纯属装饰,存一列就要配套「什么时候生成、
// 改标题动不动、能不能手改」三个状态和一套 UI,换不来任何稳定性收益。
//
// **不复用 `toc.ts` 的 slugifyHeading**:两者规则眼下几乎一样,但诉求不同——URL slug 要长度
// 上限、要 percent-encode、空标题要退回「没有 slug 段」而不是回落成 'section';章节锚点要的是
// 同名去重。耦合在一起,改一边就会伤另一边。

/** slug 的字符数上限。中文 percent-encode 后每字 9 个 ASCII 字符,60 字≈540 字节,离 URL 长度上限还远 */
export const MAX_SLUG_LEN = 60

/**
 * 标题 → slug 片段。保留中英文与数字(中文原样,可读性好),空白转 `-`,其余标点丢弃。
 *
 * 算不出东西时返回**空串**而不是占位词——那时候该退回 `/blog/12`,
 * 而不是造出一个 `/blog/12/section` 这样谁也看不懂的地址。
 */
export function slugify(title: string | null | undefined, maxLen = MAX_SLUG_LEN): string {
  const s = String(title ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}\-_]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!s) return ''
  // 截断后可能又在末尾留下 `-`,再清一次
  return (maxLen > 0 ? s.slice(0, maxLen) : s).replace(/-+$/g, '')
}

/**
 * 文章的规范站内路径。**结果是 percent-encode 过的**——sitemap/RSS 的 XML 要求 URL 已转义,
 * og:url 也不该出现原始多字节字符;浏览器地址栏会自己显示解码后的中文。
 */
export function postPath(id: number | string, title?: string | null): string {
  const slug = slugify(title)
  return slug ? `/blog/${id}/${encodeURIComponent(slug)}` : `/blog/${id}`
}
