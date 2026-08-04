import { inPrivateBranch } from '../src/lib/notebookTree'
import type { Env } from '../src/types'

/**
 * 私密笔记本(P16.5)的写入侧规则。
 *
 * 语义是**软继承**:notebooks.is_private 只决定「新建或移进这个笔记本的笔记,
 * 自动带上 is_private = 1」,**不是**「这本里的笔记被推导为私有」。
 * 事实源始终是 articles.is_private 那一列——博客发布、分享链接、备份、公开预检
 * 没有一处需要同时看两个地方。做成推导的话,任何一处漏看就是泄露。
 *
 * 放在 worker 根而不是 routes/notebooks.ts:后者已经 import 了 routes/articles.ts
 * 的 vectorizeArticle,反过来再引就成了循环依赖。
 */

export interface NotebookRow {
  id: number
  name: string
  parent_id: number | null
  is_private: number
  /** 非 null = 在回收站里。私密性判断不看它,存在性校验必须看 */
  deleted_at: string | null
}

/**
 * 取该用户的**全部**笔记本,含回收站里的。
 *
 * 为什么连已删的一起取:私密性沿祖先链继承,而祖先可能正躺在回收站里
 * (P16.1 只挡「有活着的子本时不许删」,父子一起删是允许的)。漏掉已删的祖先,
 * 那条链就断了,`inPrivateBranch` 会误判成「不在私密分支」——从回收站恢复一篇笔记时
 * 正好踩到,笔记落进私密支里却不带锁。私密判断只用 id / parent_id / is_private,
 * 与「活没活着」无关。
 *
 * **但存在性校验必须另走 `hasLiveNotebook`**:那道校验的语义是「能不能往这儿写」,
 * 回收站里的笔记本不能。两个诉求共用一次查询,但判断分开。
 */
export async function loadNotebookRows(env: Env, userId: number): Promise<NotebookRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, parent_id, is_private, deleted_at FROM notebooks WHERE user_id = ?'
  ).bind(userId).all<NotebookRow>()
  return results || []
}

/** 这个笔记本存在且不在回收站里(=可以往里写) */
export function hasLiveNotebook(rows: NotebookRow[], id: number): boolean {
  return rows.some((n) => n.id === id && !n.deleted_at)
}

/** SQLite 单条语句的绑定变量上限是 999,IN (...) 一律按这个分片 */
export const IN_CHUNK = 100

export function chunked<T>(list: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 往这个笔记本里写笔记时,是否应当自动打上私有标。
 *
 * 多花一次 notebooks 全表查询(个人库里就几十行),换的是「继承判断只有一份实现」——
 * 免费额度里紧的是请求数(10 万/天)而不是 D1 行读(500 万/天),这笔账划得来。
 */
export async function shouldBePrivate(env: Env, userId: number, notebookId: number): Promise<boolean> {
  const rows = await loadNotebookRows(env, userId)
  return inPrivateBranch(rows, notebookId)
}

/** 同上,但复用已经取好的表(批量导入时别每篇查一次) */
export function shouldBePrivateIn(rows: NotebookRow[], notebookId: number): boolean {
  return inPrivateBranch(rows, notebookId)
}

/**
 * 从 id 到根的祖先链里,**还在回收站中**的那些(不含自己)。P16.3。
 *
 * 恢复一个子本时要把它的祖先一起恢复出来,否则会留下「子本活着、父本在回收站」的状态:
 * `buildTree` 会把它兜回根(P16.1 的容错),于是你恢复的东西没回到原来的位置,
 * 而层级一深根本看不出来它挪过。
 *
 * **只恢复祖先这个壳,祖先自己的笔记仍留在回收站**——你点的是恢复这一本,
 * 不该顺带把另一本的笔记也捞回来。
 *
 * 与 `inPrivateBranch` 同款的 `seen` 防环:手改过的备份可能造出环,
 * 这里绝不能变成死循环。
 */
export function trashedAncestors(rows: NotebookRow[], id: number): number[] {
  const byId = new Map(rows.map((n) => [n.id, n]))
  const out: number[] = []
  const seen = new Set<number>([id])
  let cur = byId.get(id)?.parent_id
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const nb = byId.get(cur)
    if (!nb) break
    if (nb.deleted_at) out.push(nb.id)
    cur = nb.parent_id
  }
  return out
}
