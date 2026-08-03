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
}

/** 取该用户全部未删除的笔记本(层级判断要沿祖先链走,拿不到全表就走不了) */
export async function loadNotebookRows(env: Env, userId: number): Promise<NotebookRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT id, name, parent_id, is_private FROM notebooks WHERE user_id = ? AND deleted_at IS NULL'
  ).bind(userId).all<NotebookRow>()
  return results || []
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
