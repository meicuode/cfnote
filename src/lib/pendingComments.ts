// 待审核评论的本地留存(P11.7):访客提交后,把自己那条评论就地显示为「待审核」——
// 参考 WordPress 的做法(它用 comment_author cookie 记住作者并展示自己的待审评论)。
// 服务端 GET /api/blog/comments 只返回已通过的评论,所以待审那条存在 localStorage,
// 刷新后仍能看到;一旦被博主通过(id 出现在已批准线程里)或超过保留期就自动清掉。
//
// 纯函数,不碰 localStorage(读写留给调用方),便于单测。

import type { FlatComment, ThreadedComment } from './comments'

/** 保留期:超过就不再本地展示(避免被拒绝的评论一直挂着) */
export const PENDING_TTL_MS = 7 * 24 * 3600 * 1000

export interface PendingComment extends FlatComment {
  /** 本地记录的提交时刻(毫秒),用于过期清理 */
  saved_at: number
}

export const pendingKey = (articleId: number) => `cfnote-pending-cmt-${articleId}`

/** 追加一条待审评论(同 id 去重,后写覆盖) */
export function addPending(list: PendingComment[], item: PendingComment): PendingComment[] {
  return [...list.filter((p) => p.id !== item.id), item]
}

/** 清理:已通过(id 已出现在服务端线程里)或已过期的丢弃 */
export function prunePending(list: PendingComment[], approvedIds: Set<number>, now: number): PendingComment[] {
  return list.filter((p) => !approvedIds.has(p.id) && now - p.saved_at < PENDING_TTL_MS)
}

/** 收集已批准线程里的全部 id(顶层 + 回复) */
export function collectApprovedIds(threads: ThreadedComment[]): Set<number> {
  const ids = new Set<number>()
  for (const t of threads) {
    ids.add(t.id)
    for (const r of t.replies) ids.add(r.id)
  }
  return ids
}

/**
 * 把待审评论并入已批准线程:
 * - 回复类(有 root_id/parent_id)挂到对应顶层楼的 replies 末尾;
 * - 顶层类、或父楼已不存在(被删/被拒)的,追加为新的顶层楼。
 * 返回新数组,不改动入参。待审项带 pending: true 供渲染层降调显示。
 */
export function mergePending(threads: ThreadedComment[], pending: PendingComment[]): ThreadedComment[] {
  if (pending.length === 0) return threads
  const out: ThreadedComment[] = threads.map((t) => ({ ...t, replies: [...t.replies] }))
  const byId = new Map<number, ThreadedComment>(out.map((t) => [t.id, t]))
  for (const p of pending) {
    const item: FlatComment & { pending?: boolean } = { ...p, pending: true }
    const rootId = p.root_id ?? p.parent_id
    const top = rootId != null ? byId.get(rootId) : undefined
    if (top) top.replies.push(item)
    else {
      const asTop: ThreadedComment = { ...item, parent_id: null, root_id: null, replies: [] }
      out.push(asTop)
      byId.set(asTop.id, asTop)
    }
  }
  return out
}
