// 评论正文的极小 Markdown 子集(P13.9)。tests/commentMarkup.test.ts 覆盖。
//
// 这里**产出 token,不产出 HTML 字符串**——渲染层用 React 元素把 token 画出来:
// 文本节点由 React 自动转义,标签集合被下面的类型枚举死,结构上无从逃逸。
// 仓库里没有 HTML 消毒库,所以评论正文永不经过 marked、永不 dangerouslySetInnerHTML;
// 与 P12.12 里「用 createElement + el.text 而不是 innerHTML」是同一条论证。
//
// 子集刻意贫瘠(评论区不是文章):不给标题、图片、表格、代码块、分割线、裸 HTML、嵌套列表。
// 理由分别是——标题在评论里就是刷屏;外链图片等于追踪像素 + 刷屏 + 挂了变裂图;
// 代码块要拖进 highlight.js 且能刷出很高的楼;裸 HTML 没有消毒库,一票否决。

/** 一条评论里最多渲染几个链接,超出整条降级为纯文本 */
export const MAX_COMMENT_LINKS = 3

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; v: string }
  | { t: 'em'; v: string }
  | { t: 'del'; v: string }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; v: string }

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'quote'; c: Inline[] }
  | { t: 'ul'; items: Inline[][] }
  /** 降级:整条按纯文本原样显示(链接超限时) */
  | { t: 'plain'; v: string }

// 行内规则。顺序即优先级:代码在最前(`**x**` 里的星号不该被当成加粗),
// 行内链接在裸链接之前(否则 [文字](URL) 里的 URL 会被自己先吃掉)。
// 加粗/删除线内部允许出现**单个** * 或 ~(只有成对的才是结束标记),否则
// 「**a*b*c**」会解析成散落的星号加两段斜体——不嵌套不等于内部不许出现这个字符。
// 各分支都至少吃一个字符,不会空匹配死循环。
const INLINE =
  /`([^`\n]+)`|\*\*((?:[^*\n]|\*(?!\*))+?)\*\*|~~((?:[^~\n]|~(?!~))+?)~~|\*([^*\n]+?)\*|\[([^\]\n]{1,200})\]\(([^\s)]{1,500})\)|(https?:\/\/[^\s<>"'`]+)/g

// 裸链接尾部常常粘着标点(「见 https://x.com。」),把它们还给正文
const TRAILING = /[.,;:!?)\]}、。，！？；：」』）]+$/

/**
 * 链接协议白名单:只放 http/https。
 * 这是唯一真正的风险面——javascript: 与 data: 都能在 href 上执行/注入,
 * 而 React 不会替我们拦(它只转义文本节点,不审 href)。
 */
export function safeHref(raw: string): string | null {
  const s = (raw || '').trim()
  return /^https?:\/\/\S+$/i.test(s) ? s : null
}

/** 统一换行,并把 3 个以上连续空行折成 2 个(否则 2000 字全打回车就能刷出一整屏空白楼) */
export function normalizeCommentText(src: string): string {
  return (src || '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(src)) !== null) {
    if (m.index > last) out.push({ t: 'text', v: src.slice(last, m.index) })
    if (m[1] !== undefined) out.push({ t: 'code', v: m[1] })
    else if (m[2] !== undefined) out.push({ t: 'strong', v: m[2] })
    else if (m[3] !== undefined) out.push({ t: 'del', v: m[3] })
    else if (m[4] !== undefined) out.push({ t: 'em', v: m[4] })
    else if (m[5] !== undefined) {
      const href = safeHref(m[6])
      // 协议不合法就原样当文本显示,而不是悄悄扔掉——读者该看见作者写了什么
      if (href) out.push({ t: 'link', href, v: m[5] })
      else out.push({ t: 'text', v: m[0] })
    } else if (m[7] !== undefined) {
      const bare = m[7].replace(TRAILING, '')
      const href = safeHref(bare)
      if (href) {
        out.push({ t: 'link', href, v: bare })
        if (bare.length < m[7].length) out.push({ t: 'text', v: m[7].slice(bare.length) })
      } else {
        out.push({ t: 'text', v: m[7] })
      }
    }
    last = m.index + m[0].length
  }
  if (last < src.length) out.push({ t: 'text', v: src.slice(last) })
  return mergeText(out)
}

/**
 * 合并相邻的 text token。解析中途会产出好几段挨着的文本(链接协议非法时的原样回退、
 * 裸链接尾部还回来的标点等),渲染出来一模一样,但合并后 token 序列是规范的——
 * 单测断言不必去数它到底被切成了几段。
 */
function mergeText(items: Inline[]): Inline[] {
  const out: Inline[] = []
  for (const x of items) {
    const prev = out[out.length - 1]
    if (x.t === 'text' && prev && prev.t === 'text') prev.v += x.v
    else out.push(x)
  }
  return out
}

/** 正文里有效链接的个数(行内链接 + 裸链接),协议非法的不算 */
export function countLinks(src: string): number {
  let n = 0
  let m: RegExpExecArray | null
  INLINE.lastIndex = 0
  while ((m = INLINE.exec(src)) !== null) {
    if (m[5] !== undefined && safeHref(m[6])) n++
    else if (m[7] !== undefined && safeHref(m[7].replace(TRAILING, ''))) n++
  }
  return n
}

/**
 * 评论正文 → 块级 token。
 * 链接超过 MAX_COMMENT_LINKS 时**整条**降级为纯文本(而不是逐个吃掉多余的):
 * 半边渲染半边不渲染更难读,也让人看不出发生了什么。链接刷屏是垃圾评论的主要形态,
 * 这里只是不给它渲染成可点的,不拦提交——审核制下拦提交只会让正常人莫名其妙。
 */
export function parseCommentMarkup(raw: string): Block[] {
  const src = normalizeCommentText(raw)
  if (!src) return []
  if (countLinks(src) > MAX_COMMENT_LINKS) return [{ t: 'plain', v: src }]

  const blocks: Block[] = []
  let para: string[] = []
  let quote: string[] = []
  let items: string[] = []
  const flushPara = () => { if (para.length) { blocks.push({ t: 'p', c: parseInline(para.join('\n')) }); para = [] } }
  const flushQuote = () => { if (quote.length) { blocks.push({ t: 'quote', c: parseInline(quote.join('\n')) }); quote = [] } }
  const flushList = () => { if (items.length) { blocks.push({ t: 'ul', items: items.map((s) => parseInline(s)) }); items = [] } }

  for (const line of src.split('\n')) {
    const q = /^>\s?(.*)$/.exec(line)
    // 列表项要求符号后必须有空格,这样行首的 *斜体* 不会被误判成列表
    const li = /^[-*]\s+(.+)$/.exec(line)
    if (q) { flushPara(); flushList(); quote.push(q[1]); continue }
    if (li) { flushPara(); flushQuote(); items.push(li[1]); continue }
    if (line.trim() === '') { flushPara(); flushQuote(); flushList(); continue }
    flushQuote(); flushList(); para.push(line)
  }
  flushPara(); flushQuote(); flushList()
  return blocks
}
