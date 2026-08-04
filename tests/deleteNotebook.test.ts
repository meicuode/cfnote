import { describe, it, expect } from 'vitest'
import { deleteNotebookPrompt, TYPE_TO_CONFIRM_ARTICLES } from '../src/lib/deleteNotebook'
import type { DeleteImpact } from '../src/lib/deleteNotebook'

// P16.3 删除确认框的文案与强度。
// 这些分支埋在 JSX 里就只能靠人眼复核,而人眼复核不了「published 为 0 时那句该消失」。

const im = (o: Partial<DeleteImpact> = {}): DeleteImpact =>
  ({ notebooks: 1, articles: 0, published: 0, shared: 0, ...o })

describe('deleteNotebookPrompt', () => {
  it('空笔记本:不弹一堆 0', () => {
    const p = deleteNotebookPrompt('草稿', im())
    expect(p.message).toContain('这个笔记本是空的')
    expect(p.message).not.toContain('0 篇')
    expect(p.confirmText).toBe('移入回收站')
  })

  it('有笔记但没有子本:不提子本', () => {
    const p = deleteNotebookPrompt('技术', im({ articles: 12 }))
    expect(p.message).toContain('12 篇笔记会一并移入回收站')
    expect(p.message).not.toContain('子笔记本')
  })

  it('有子本:子本数是「不含自己」的', () => {
    // notebooks 是整棵子树含自己,文案里要说的是「连同几个子笔记本」
    const p = deleteNotebookPrompt('ERP笔记', im({ notebooks: 4, articles: 47 }))
    expect(p.message).toContain('连同 3 个子笔记本、47 篇笔记')
  })

  it('没有外部影响时不提下线与分享(不制造焦虑)', () => {
    const p = deleteNotebookPrompt('技术', im({ articles: 12 }))
    expect(p.message).not.toContain('博客')
    expect(p.message).not.toContain('分享')
  })

  it('有已发布的就必须说,而且要说清是「会从博客下线」', () => {
    const p = deleteNotebookPrompt('技术', im({ articles: 12, published: 3 }))
    expect(p.message).toContain('3 篇已发布，会从博客下线')
  })

  it('分享链接单独成句,两者都有时并列', () => {
    const both = deleteNotebookPrompt('技术', im({ articles: 12, published: 3, shared: 2 }))
    expect(both.message).toContain('3 篇已发布')
    expect(both.message).toContain('2 个分享链接会失效')

    const onlyShared = deleteNotebookPrompt('技术', im({ articles: 12, shared: 2 }))
    expect(onlyShared.message).toContain('2 个分享链接会失效')
    expect(onlyShared.message).not.toContain('已发布')
  })

  it('永远讲清可逆性', () => {
    for (const p of [deleteNotebookPrompt('a', im()), deleteNotebookPrompt('b', im({ articles: 99 }))]) {
      expect(p.message).toContain('30 天内可从回收站整棵恢复')
      expect(p.message).toContain('附件不会被删除')
    }
  })

  it('按钮写明动作与数量,不是「确定」', () => {
    expect(deleteNotebookPrompt('技术', im({ articles: 47 })).confirmText).toBe('移入回收站（47 篇）')
  })

  describe('打字确认的阈值', () => {
    it('不超过阈值不要求打字', () => {
      expect(deleteNotebookPrompt('技术', im({ articles: TYPE_TO_CONFIRM_ARTICLES })).typeToConfirm).toBe('')
    })

    it('超过阈值要求原样打出笔记本名', () => {
      expect(deleteNotebookPrompt('技术', im({ articles: TYPE_TO_CONFIRM_ARTICLES + 1 })).typeToConfirm).toBe('技术')
    })

    it('边界是「超过」而不是「达到」', () => {
      // 差一篇就升级会让人莫名其妙,而且这个阈值本来就是个判断不是计算
      expect(deleteNotebookPrompt('a', im({ articles: 50 })).typeToConfirm).toBe('')
      expect(deleteNotebookPrompt('a', im({ articles: 51 })).typeToConfirm).toBe('a')
    })
  })
})
