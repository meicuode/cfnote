import { describe, it, expect } from 'vitest'
import {
  addPending, prunePending, mergePending, collectApprovedIds, pendingKey, PENDING_TTL_MS,
  type PendingComment,
} from '../src/lib/pendingComments'
import type { ThreadedComment } from '../src/lib/comments'

const mkPending = (over: Partial<PendingComment> = {}): PendingComment => ({
  id: 100,
  parent_id: null,
  root_id: null,
  author_name: '访客',
  content: '待审内容',
  created_at: '2026-07-27T10:00:00Z',
  saved_at: 1_000_000,
  ...over,
})

const mkTop = (id: number, replies: any[] = []): ThreadedComment => ({
  id,
  parent_id: null,
  root_id: null,
  author_name: `楼主${id}`,
  content: `内容${id}`,
  created_at: '2026-07-27T09:00:00Z',
  replies,
})

describe('pendingComments(待审评论本地留存,P11.7)', () => {
  it('localStorage 键按文章隔离', () => {
    expect(pendingKey(12)).toBe('cfnote-pending-cmt-12')
    expect(pendingKey(12)).not.toBe(pendingKey(13))
  })

  it('addPending 追加并按 id 去重(后写覆盖)', () => {
    const a = mkPending({ id: 1, content: '旧' })
    const list = addPending([a], mkPending({ id: 1, content: '新' }))
    expect(list).toHaveLength(1)
    expect(list[0].content).toBe('新')
    expect(addPending(list, mkPending({ id: 2 }))).toHaveLength(2)
  })

  it('prunePending 丢弃已通过与已过期的', () => {
    const now = 10_000_000
    const list = [
      mkPending({ id: 1, saved_at: now - 1000 }),            // 保留
      mkPending({ id: 2, saved_at: now - 1000 }),            // 已通过 → 丢
      mkPending({ id: 3, saved_at: now - PENDING_TTL_MS - 1 }), // 过期 → 丢
    ]
    const kept = prunePending(list, new Set([2]), now)
    expect(kept.map((p) => p.id)).toEqual([1])
  })

  it('collectApprovedIds 收集顶层与回复的 id', () => {
    const threads = [mkTop(1, [{ ...mkTop(2), replies: undefined }]), mkTop(3)]
    const ids = collectApprovedIds(threads as any)
    expect([...ids].sort()).toEqual([1, 2, 3])
  })

  it('mergePending:回复挂到对应楼层末尾并标记 pending', () => {
    const threads = [mkTop(1), mkTop(2)]
    const merged = mergePending(threads, [mkPending({ id: 50, parent_id: 1, root_id: 1 })])
    expect(merged[0].replies).toHaveLength(1)
    expect(merged[0].replies[0].id).toBe(50)
    expect((merged[0].replies[0] as any).pending).toBe(true)
    expect(merged[1].replies).toHaveLength(0)
  })

  it('mergePending:顶层待审追加为新楼', () => {
    const merged = mergePending([mkTop(1)], [mkPending({ id: 60 })])
    expect(merged).toHaveLength(2)
    expect(merged[1].id).toBe(60)
    expect((merged[1] as any).pending).toBe(true)
  })

  it('mergePending:父楼不存在时降级为顶层,不丢失', () => {
    const merged = mergePending([mkTop(1)], [mkPending({ id: 70, parent_id: 999, root_id: 999 })])
    expect(merged).toHaveLength(2)
    expect(merged[1].id).toBe(70)
    expect(merged[1].parent_id).toBeNull()
  })

  it('mergePending 不改动入参(纯函数)', () => {
    const threads = [mkTop(1)]
    mergePending(threads, [mkPending({ id: 80, parent_id: 1, root_id: 1 })])
    expect(threads[0].replies).toHaveLength(0)
    expect(mergePending(threads, [])).toBe(threads)
  })
})
