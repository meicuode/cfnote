// 窄屏单列的返回栈(P15.1)。
//
// 桌面是四栏并排:侧栏 / 列表 / 正文 / AI。窄屏放不下——`index.html` 的 viewport 是
// `width=device-width`,手机不会缩成桌面视图,而是把 224+288+… 硬塞进 390px。
// 所以 <lg 改成一次只显示一层,顶栏出返回箭头,层与层之间像 iOS 备忘录那样退栈。
//
// 「在哪一层」是状态,「显示几层」是 CSS:本文件只算前者,一行 window.innerWidth 都不读。
// 沿用 P12.2 博客页的结论——JS 判视口会先按错误的分支渲染一帧再跳,断点不会。
// 因此桌面下 pane 照常变化,只是被 lg: 前缀的类整个盖住,等于不起作用。

import type { RoutePanel } from './route'

export type Pane = 'nav' | 'list' | 'main'

/** 右侧工作区的四种形态。决定返回栈有几层 */
export type Workspace = 'notes' | 'files' | 'blog-articles' | 'blog-other'

export type BlogView = 'articles' | 'comments' | 'layout' | null

export function workspaceOf(blogView: BlogView, showFiles: boolean): Workspace {
  if (blogView === 'articles') return 'blog-articles'
  if (blogView) return 'blog-other'
  return showFiles ? 'files' : 'notes'
}

/**
 * 这个工作区有没有「列表」这一层。
 * 文件管理的文件列表**本身就是**主内容(它的目录树 P11.6 已经并进侧栏了),
 * 评论管理与页面布局是单栏——这三个从正文返回时直接回侧栏,不该插一层空列表。
 */
export function hasListPane(ws: Workspace): boolean {
  return ws === 'notes' || ws === 'blog-articles'
}

/** 从侧栏进入某工作区时停在哪一层 */
export function entryPane(ws: Workspace): Pane {
  return hasListPane(ws) ? 'list' : 'main'
}

/** 返回上一层;'nav'(侧栏)是栈底,再返回不动 */
export function backPane(pane: Pane, ws: Workspace): Pane {
  if (pane === 'main') return hasListPane(ws) ? 'list' : 'nav'
  return 'nav'
}

/** 顶栏是否显示返回箭头(窄屏) */
export function canGoBack(pane: Pane): boolean {
  return pane !== 'nav'
}

/**
 * 按 URL 恢复视图时停在哪一层:刷新后手机上不该一律掉回侧栏。
 * settings/stats/logs 是浮在工作区之上的弹窗,不占层——按它们底下的视图算。
 */
export function paneForRoute(panel: RoutePanel, hasView: boolean, hasArticle: boolean): Pane {
  if (panel === 'files' || panel === 'comments' || panel === 'layout') return 'main'
  if (panel === 'blog') return 'list'
  if (hasArticle) return 'main'
  return hasView ? 'list' : 'nav'
}
