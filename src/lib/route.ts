// 主应用 URL 路由(P10.6):把「当前笔记本/虚拟视图 + 打开的文章 + 主模块面板」编进 URL,
// 刷新与前进/后退按 URL 恢复。纯函数(解析/生成),供 Layout 双向同步与单测复用。
// 与 BlogPage 的手写 pushState/popstate 同一风格,不引入路由库。
//
// 路径 = 基础位置:  /  |  /nb/:id[/:articleId]  |  /private[/:articleId]
//                    |  /trash[/:articleId]     |  /tag/:name[/:articleId]
// query = 叠加面板:  ?panel=files|settings|stats|logs|blog|comments|layout
//                    (blog/comments/layout 为博客管理的三个子视图)
// 兼容入口:          /?article=:id  (window.open 深链;消费后规范化为 /nb/:nbId/:id)

export type RouteView =
  | { kind: 'none' }
  | { kind: 'notebook'; id: number }
  | { kind: 'private' }
  | { kind: 'trash' }
  | { kind: 'tag'; name: string }

export type RoutePanel = 'files' | 'settings' | 'stats' | 'logs' | 'blog' | 'comments' | 'layout' | null

/**
 * 文件管理子视图(P11.6):侧栏二级菜单选中项;名字不入 URL,渲染时从 overview 现取。
 * P17.3 起 folder / notebook 的 id 可为 null(根层 / 不按笔记本筛),
 * 分别写成 ?fm=folder 与 ?fm=nb。
 */
export type FmSub =
  | { kind: 'all' }
  | { kind: 'unref' }
  | { kind: 'notebook'; id: number | null }
  | { kind: 'folder'; id: number | null }

export interface MainRoute {
  view: RouteView
  articleId: number | null
  panel: RoutePanel
  /** 仅在 panel==='files' 时有意义;null = 默认的「全部文件」 */
  fm: FmSub | null
  /** 来自 ?article=<id> 的兼容深链;需异步拉文章定位其笔记本(见 Layout 初始化) */
  legacyArticleId: number | null
}

const PANELS = ['files', 'settings', 'stats', 'logs', 'blog', 'comments', 'layout'] as const

/** 正整数(文章 id)否则 null;草稿负 id / 0 / 非法一律不入 URL */
function posInt(s: string | null | undefined): number | null {
  if (!s) return null
  const n = Number(s)
  return Number.isInteger(n) && n > 0 ? n : null
}

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/**
 * 解析 ?fm= :unref / nb / nb:<id> / folder / folder:<id>;其余(含 all 与非法值)→ null。
 * 不带 :<id> 的 nb / folder 是 P17.3 加的根层形态(「笔记附件」不筛 / 「我的文件夹」根)。
 */
function parseFm(raw: string | null, panel: RoutePanel): FmSub | null {
  if (panel !== 'files' || !raw) return null
  if (raw === 'unref') return { kind: 'unref' }
  if (raw === 'nb') return { kind: 'notebook', id: null }
  if (raw === 'folder') return { kind: 'folder', id: null }
  const m = /^(nb|folder):(\d+)$/.exec(raw)
  if (!m) return null
  const id = posInt(m[2])
  if (!id) return null
  return m[1] === 'nb' ? { kind: 'notebook', id } : { kind: 'folder', id }
}

/** 解析 location.pathname + location.search → 结构化路由 */
export function parseLocation(pathname: string, search: string): MainRoute {
  const params = new URLSearchParams(search || '')
  const rawPanel = params.get('panel')
  const panel: RoutePanel = (PANELS as readonly string[]).includes(rawPanel || '') ? (rawPanel as RoutePanel) : null
  const legacyArticleId = posInt(params.get('article'))
  const fm = parseFm(params.get('fm'), panel)

  const segs = (pathname || '/').split('/').filter(Boolean).map(decode)
  let view: RouteView = { kind: 'none' }
  let articleId: number | null = null

  if (segs[0] === 'nb') {
    const id = posInt(segs[1])
    if (id) {
      view = { kind: 'notebook', id }
      articleId = posInt(segs[2])
    }
  } else if (segs[0] === 'private') {
    view = { kind: 'private' }
    articleId = posInt(segs[1])
  } else if (segs[0] === 'trash') {
    view = { kind: 'trash' }
    articleId = posInt(segs[1])
  } else if (segs[0] === 'tag' && segs[1]) {
    view = { kind: 'tag', name: segs[1] }
    articleId = posInt(segs[2])
  }

  return { view, articleId, panel, fm, legacyArticleId }
}

/** 结构化路由 → location 字符串(pathname + search),供 push/replaceState */
export function buildLocation(r: { view: RouteView; articleId: number | null; panel: RoutePanel; fm?: FmSub | null }): string {
  let base = '/'
  switch (r.view.kind) {
    case 'notebook':
      base = `/nb/${r.view.id}`
      break
    case 'private':
      base = '/private'
      break
    case 'trash':
      base = '/trash'
      break
    case 'tag':
      base = `/tag/${encodeURIComponent(r.view.name)}`
      break
    case 'none':
      base = '/'
      break
  }
  // 文章 id 仅在 >0 且有基础视图时追加(none 视图不挂文章)
  if (r.view.kind !== 'none' && r.articleId && r.articleId > 0) base += `/${r.articleId}`
  let search = r.panel ? `?panel=${r.panel}` : ''
  // 文件管理子视图:仅非默认(all)时才写,保持 URL 干净。
  // id 为 null 的根层写成不带冒号的 nb / folder(P17.3)
  if (search && r.panel === 'files' && r.fm && r.fm.kind !== 'all') {
    const f = r.fm
    const seg =
      f.kind === 'unref' ? 'unref'
      : f.kind === 'notebook' ? (f.id == null ? 'nb' : `nb:${f.id}`)
      : (f.id == null ? 'folder' : `folder:${f.id}`)
    search += `&fm=${seg}`
  }
  return base + search
}

/** 判定裸根路径(无任何视图/文章/面板/兼容深链)→ Layout 回退到 localStorage 恢复 */
export function isEmptyRoute(r: MainRoute): boolean {
  return r.view.kind === 'none' && r.articleId === null && r.panel === null && r.legacyArticleId === null
}
