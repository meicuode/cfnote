import { describe, it, expect } from 'vitest'
import {
  validateCommentInput,
  resolveThreadParent,
  buildThread,
  isHoneypotTripped,
  commentAvatar,
  MAX_NAME,
  MAX_CONTENT,
  type FlatComment,
} from '../src/lib/comments'

describe('validateCommentInput', () => {
  it('昵称必填', () => {
    expect(validateCommentInput({ name: '  ', content: 'hi' }).ok).toBe(false)
  })
  it('正文必填', () => {
    expect(validateCommentInput({ name: 'a', content: '   ' }).ok).toBe(false)
  })
  it('昵称过长被拒', () => {
    expect(validateCommentInput({ name: 'x'.repeat(MAX_NAME + 1), content: 'hi' }).ok).toBe(false)
  })
  it('正文过长被拒', () => {
    expect(validateCommentInput({ name: 'a', content: 'x'.repeat(MAX_CONTENT + 1) }).ok).toBe(false)
  })
  it('邮箱可选但格式要对', () => {
    expect(validateCommentInput({ name: 'a', content: 'hi', email: 'bad' }).ok).toBe(false)
    expect(validateCommentInput({ name: 'a', content: 'hi', email: 'x@y.com' }).ok).toBe(true)
    expect(validateCommentInput({ name: 'a', content: 'hi' }).ok).toBe(true)
  })
})

describe('resolveThreadParent(2 层夹取)', () => {
  it('无父 = 顶层,parent/root 皆空', () => {
    expect(resolveThreadParent(null)).toEqual({ parent_id: null, root_id: null })
  })
  it('回复顶层评论:root 取该顶层自身', () => {
    // 顶层评论 root_id 为空 → 回复的 root 回退为父的 id
    expect(resolveThreadParent({ id: 5, root_id: null })).toEqual({ parent_id: 5, root_id: 5 })
  })
  it('回复的回复:归并到同一顶层楼(root 不再加深)', () => {
    // 父身处第 2 层(root_id=5),再回复仍 root=5,只记 parent=8
    expect(resolveThreadParent({ id: 8, root_id: 5 })).toEqual({ parent_id: 8, root_id: 5 })
  })
})

describe('buildThread', () => {
  const c = (id: number, parent_id: number | null, root_id: number | null, t: string): FlatComment => ({
    id, parent_id, root_id, author_name: 'u' + id, content: 'c' + id, created_at: t,
  })

  it('分组为顶层 + 扁平回复,均按时间升序', () => {
    const flat: FlatComment[] = [
      c(1, null, null, '2026-01-01T10:00:00Z'),
      c(3, 1, 1, '2026-01-01T10:05:00Z'),
      c(2, null, null, '2026-01-01T09:00:00Z'),
      c(4, 3, 1, '2026-01-01T10:10:00Z'), // 回复的回复,已夹到 root=1
    ]
    const tops = buildThread(flat)
    expect(tops.map((t) => t.id)).toEqual([2, 1]) // 顶层按时间升序
    const first = tops.find((t) => t.id === 1)!
    expect(first.replies.map((r) => r.id)).toEqual([3, 4]) // 同一楼下的回复按时间升序
    expect(tops.find((t) => t.id === 2)!.replies).toEqual([])
  })

  it('空输入 → 空数组', () => {
    expect(buildThread([])).toEqual([])
  })
})

describe('isHoneypotTripped', () => {
  it('空/未填 = 未触发', () => {
    expect(isHoneypotTripped('')).toBe(false)
    expect(isHoneypotTripped(undefined)).toBe(false)
    expect(isHoneypotTripped('   ')).toBe(false)
  })
  it('有值 = 机器人', () => {
    expect(isHoneypotTripped('http://spam')).toBe(true)
  })
})

describe('commentAvatar(头像占位,P11.7)', () => {
  it('取昵称首字并大写', () => {
    expect(commentAvatar('alice').char).toBe('A')
    expect(commentAvatar('  张三 ').char).toBe('张')
  })

  it('emoji 昵称按码点切分,不出半个代理对', () => {
    const { char } = commentAvatar('🐱喵')
    expect(char).toBe('🐱')
    expect(Array.from(char)).toHaveLength(1)
  })

  it('空昵称回退 ?', () => {
    expect(commentAvatar('').char).toBe('?')
    expect(commentAvatar(null).char).toBe('?')
    expect(commentAvatar('   ').char).toBe('?')
  })

  it('同一昵称永远同色,不同昵称至少能分出多种色', () => {
    expect(commentAvatar('alice').color).toBe(commentAvatar('alice').color)
    expect(commentAvatar('alice').color).toMatch(/^#[0-9a-f]{6}$/)
    const colors = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => commentAvatar(n).color))
    expect(colors.size).toBeGreaterThan(1)
  })
})
