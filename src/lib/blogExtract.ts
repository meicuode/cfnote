// 博客列表的摘要与缩略图提取(worker 与前端共用,纯函数,测试见 tests/blogExtract.test.ts)

// 取正文中第一张图片地址(markdown 形式或内嵌 <img>,按出现位置取更早的;跳过代码块)
export function mdFirstImage(md: string): string | null {
  const t = (md || '').replace(/```[\s\S]*?(?:```|$)/g, (m) => ' '.repeat(m.length))
  const m1 = /!\[[^\]]*\]\(([^)\s]+)[^)]*\)/.exec(t)
  const m2 = /<img[^>]*\ssrc=["']([^"']+)["']/i.exec(t)
  if (m1 && m2) return m1.index <= m2.index ? m1[1] : m2[1]
  return m1?.[1] || m2?.[1] || null
}

// 剥掉 Markdown 语法取纯文本摘要(列表页两行简介)
export function mdExcerpt(md: string, len = 120): string {
  let t = md || ''
  t = t.replace(/```[\s\S]*?(?:```|$)/g, ' ') // 代码块
  t = t.replace(/<[^>]+>/g, ' ') // 内嵌 HTML 标签
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题井号
  t = t.replace(/^\s{0,3}>\s?/gm, '') // 引用
  t = t.replace(/^\s*([-*+]|\d+\.)\s+/gm, '') // 列表标记
  t = t.replace(/\|/g, ' ') // 表格线
  t = t.replace(/[*_~`]+/g, '') // 强调符号
  t = t.replace(/\s+/g, ' ').trim()
  return t.length > len ? t.slice(0, len) + '…' : t
}
