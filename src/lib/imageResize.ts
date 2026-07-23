// 预览中拖拽调整图片宽度 → 把源文中对应的图片改写为标准内嵌 HTML(<img width>)。
// 不引入私有语法:CommonMark 的 Raw HTML 即标准做法(与手写 <img width> 完全一致)。

export interface ImageMatch {
  start: number
  end: number
  src: string
  alt: string
  tag: string
}

// 枚举源文中的图片构造(![alt](url) 与 <img>),跳过围栏代码块与行内代码
export function findImages(source: string): ImageMatch[] {
  const codeRanges: [number, number][] = []
  const codeRe = /```[\s\S]*?(?:```|$)|`[^`\n]*`/g
  let cm: RegExpExecArray | null
  while ((cm = codeRe.exec(source))) codeRanges.push([cm.index, cm.index + cm[0].length])
  const inCode = (i: number) => codeRanges.some(([s, e]) => i >= s && i < e)

  const out: ImageMatch[] = []
  const re = /!\[([^\]]*)\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)|<img\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) {
    if (inCode(m.index)) continue
    const tag = m[0]
    let src = ''
    let alt = ''
    if (tag.startsWith('<')) {
      src = /\bsrc\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? /\bsrc\s*=\s*'([^']*)'/i.exec(tag)?.[1] ?? ''
      alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? ''
    } else {
      alt = m[1] || ''
      src = (m[2] || '').replace(/^<|>$/g, '')
    }
    out.push({ start: m.index, end: m.index + tag.length, src, alt, tag })
  }
  return out
}

// 属性值转义:只转义引号与尖括号,不动 &(HTML 形式提取出的 alt 可能已含实体,避免二次转义)
const escAttr = (s: string) => s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 把第 nth 个(按出现顺序,0 起)src 相同的图片改写为限定宽度的标准 <img>:
// - markdown 形式 → 转为 <img src alt width>(去掉高度,等比缩放)
// - <img> 形式 → 原位替换 width、移除 height,其余属性(title/style 等)保留
// 找不到目标返回 null(调用方保持源文不变)
export function setImageWidth(source: string, src: string, nth: number, width: number): string | null {
  if (!src || nth < 0 || !Number.isFinite(width) || width <= 0) return null
  const target = findImages(source).filter((i) => i.src === src)[nth]
  if (!target) return null

  let replacement: string
  if (target.tag.startsWith('<')) {
    replacement = target.tag
      .replace(/\s+width\s*=\s*("[^"]*"|'[^']*'|\d+)/gi, '')
      .replace(/\s+height\s*=\s*("[^"]*"|'[^']*'|\d+)/gi, '')
      .replace(/<img\b/i, `<img width="${Math.round(width)}"`)
  } else {
    const alt = target.alt ? ` alt="${escAttr(target.alt)}"` : ''
    replacement = `<img src="${escAttr(src)}"${alt} width="${Math.round(width)}">`
  }
  return source.slice(0, target.start) + replacement + source.slice(target.end)
}
