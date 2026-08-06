/**
 * 搜索结果的片段与排序(P17.5)。纯函数,测试见 tests/search.test.ts。
 *
 * 这一批把默认搜索从 RRF 融合改成**两层硬分层**:有精确命中的文章在前,
 * 只有语义命中的在后。理由是 RRF 会把精确命中埋到语义命中下面,而
 * 「我明明搜了这个词,为什么这篇排在后面」是不可解释的——个人知识库里
 * 主流用法恰恰是「我记得有个词」。
 *
 * 代价说在明处:中文 LIKE 没有词边界(worker/routes/search.ts 顶上那条不用
 * FTS5 的决定),搜「本」会命中笔记本/本地/日本/基本。第一层没有最低阈值,
 * 短查询会被噪音塞满。splitSlots 的保底名额就是为这个留的。
 */

/** 命中点前后各取多少字 */
export const SNIPPET_BEFORE = 40
export const SNIPPET_AFTER = 120
/** 每篇最多展示几段 */
export const MAX_SNIPPETS = 3
/** 最多扫出几个窗口。超出的既不展示也不计数——「另有 N 处」因此是下限而非精确值 */
export const SNIPPET_SCAN_MAX = 10
/** 单个词最多数几次命中(正文可以很长,不设上限时一个高频词能扫出上万个位置) */
export const HITS_PER_TERM = 20
/** 两段共有这么多连续字符就算重复 */
export const OVERLAP_MIN = 40
/** 一次最多返回几篇 */
export const RESULT_LIMIT = 10
/** 给第二层留的保底名额 */
export const RESERVED_SEMANTIC = 3

export type SnippetKind = 'exact' | 'semantic'
export interface Snippet {
  text: string
  kind: SnippetKind
}

/** 所有词在正文里的命中位置,去重后按位置升序 */
export function findHitPositions(content: string, terms: string[]): number[] {
  const text = (content || '').toLowerCase()
  if (!text) return []
  const out: number[] = []
  for (const raw of terms) {
    const t = (raw || '').toLowerCase()
    if (!t) continue
    let i = text.indexOf(t)
    let n = 0
    while (i >= 0 && n < HITS_PER_TERM) {
      out.push(i)
      n++
      i = text.indexOf(t, i + t.length)
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

/**
 * 多个**互不重叠**的命中窗口。此前只取第一处(makeSnippet),长文里等于随机
 * 挑一段给人看。无命中返回空数组而不是正文开头——调用方要能区分
 * 「命中了但摘不出来」和「压根没命中」。
 */
export function makeSnippets(content: string, terms: string[], max = SNIPPET_SCAN_MAX): string[] {
  const text = content || ''
  const hits = findHitPositions(text, terms)
  if (hits.length === 0) return []
  const out: string[] = []
  let covered = -1
  for (const p of hits) {
    if (out.length >= max) break
    if (p <= covered) continue
    const start = Math.max(0, p - SNIPPET_BEFORE)
    const end = Math.min(text.length, p + SNIPPET_AFTER)
    out.push((start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''))
    covered = end - 1
  }
  return out
}

/** 归一化到只剩「内容」:空白与省略号不参与重复判断 */
const norm = (s: string) => (s || '').replace(/[\s…]/g, '')

/** 两段是否算重复:共有 OVERLAP_MIN 个连续字符即算,短段则要求整段被包含 */
export function snippetsOverlap(a: string, b: string): boolean {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  if (short.length <= OVERLAP_MIN) return long.includes(short)
  for (let i = 0; i + OVERLAP_MIN <= short.length; i++) {
    if (long.includes(short.slice(i, i + OVERLAP_MIN))) return true
  }
  return false
}

/**
 * 去掉互相重叠的片段,保留先出现的那个(调用方把精确片段排在前面,于是
 * 精确的赢)。不做这一步的表现:向量切片之间本就重叠 100 字
 * (worker/utils.ts 的 CHUNK_OVERLAP),而关键词摘要常常整段落在某个切片内部——
 * 同一段文字在同一篇下面显示两遍,看着像坏了。
 */
export function dedupeSnippets(list: Snippet[]): Snippet[] {
  const kept: Snippet[] = []
  for (const s of list) {
    if (!norm(s.text)) continue
    if (kept.some((k) => snippetsOverlap(k.text, s.text))) continue
    kept.push(s)
  }
  return kept
}

/**
 * 切成 token 交给 React 渲染。**产出数组不产出 HTML 字符串**——
 * 仓库里没有 HTML 消毒库,搜索片段是任意正文,永不经过 dangerouslySetInnerHTML
 * (与 src/lib/commentMarkup.ts 顶上同一条论证)。
 */
export function highlightParts(text: string, terms: string[]): { text: string; hit: boolean }[] {
  const src = text || ''
  if (!src) return []
  // 长词优先,否则搜「笔记 笔」时「笔记」会被「笔」先切开
  const needles = [...new Set(terms.map((t) => (t || '').toLowerCase()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
  if (needles.length === 0) return [{ text: src, hit: false }]

  const lower = src.toLowerCase()
  const out: { text: string; hit: boolean }[] = []
  let buf = ''
  let i = 0
  while (i < src.length) {
    const n = needles.find((t) => lower.startsWith(t, i))
    if (n) {
      if (buf) { out.push({ text: buf, hit: false }); buf = '' }
      out.push({ text: src.slice(i, i + n.length), hit: true })
      i += n.length
    } else {
      buf += src[i]
      i++
    }
  }
  if (buf) out.push({ text: buf, hit: false })
  return out
}

/** 第一层内部的排序依据 */
export interface ExactStat {
  /** 每个查询词都命中(标题或正文) */
  allTerms: boolean
  /** 标题里有命中 */
  titleHit: boolean
  /** 命中总次数(每词封顶 HITS_PER_TERM) */
  hits: number
}

/**
 * 第一层排序:全部词命中 > 部分命中,然后标题命中 > 仅正文,然后次数多的在前。
 * 「全部词命中」这一档是给多词查询挡噪音用的——关键词腿的 SQL 是 OR
 * (命中任一词就进来),没有这一档的话搜「向量 检索」时只含「检索」的文章
 * 会和两个词都有的并列。单字查询挡不住,那是中文 LIKE 无词边界的固有代价。
 */
export function compareExact(a: ExactStat, b: ExactStat): number {
  if (a.allTerms !== b.allTerms) return a.allTerms ? -1 : 1
  if (a.titleHit !== b.titleHit) return a.titleHit ? -1 : 1
  return b.hits - a.hits
}

/**
 * 名额分配。第二层保底 RESERVED_SEMANTIC 个位置,**第一层再多也不能占满**:
 * 否则一个高频短词就能把语义腿整个挤没,而那正是搜索里唯一能找到
 * 「说的是这件事但用词不同」的那条路。第二层不够或为空时名额还给第一层。
 */
export function splitSlots(
  exactCount: number,
  semanticCount: number,
  limit = RESULT_LIMIT,
  reserve = RESERVED_SEMANTIC,
): { exact: number; semantic: number } {
  const r = Math.min(Math.max(0, reserve), Math.max(0, semanticCount))
  const exact = Math.min(Math.max(0, exactCount), Math.max(0, limit - r))
  const semantic = Math.min(Math.max(0, semanticCount), Math.max(0, limit - exact))
  return { exact, semantic }
}
