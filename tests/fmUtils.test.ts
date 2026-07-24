import { describe, it, expect } from 'vitest'
import { buildFolderTree, fmtSize, previewKind } from '../src/lib/fmUtils'

describe('buildFolderTree', () => {
  it('平铺行构建嵌套树,各层按名称排序', () => {
    const tree = buildFolderTree([
      { id: 1, name: '资料', parent_id: null },
      { id: 2, name: '安装包', parent_id: null },
      { id: 3, name: '2026', parent_id: 1 },
      { id: 4, name: '2025', parent_id: 1 },
    ])
    expect(tree.map((n) => n.name)).toEqual(['安装包', '资料'])
    const ziliao = tree.find((n) => n.id === 1)!
    expect(ziliao.children.map((n) => n.name)).toEqual(['2025', '2026'])
  })

  it('孤儿(父不存在)提升为根,不丢失', () => {
    const tree = buildFolderTree([
      { id: 5, name: '孤儿', parent_id: 999 },
      { id: 6, name: '正常', parent_id: null },
    ])
    expect(tree.map((n) => n.id).sort()).toEqual([5, 6])
  })

  it('指向自己的行提升为根(防御)', () => {
    const tree = buildFolderTree([{ id: 7, name: '自指', parent_id: 7 }])
    expect(tree).toHaveLength(1)
    expect(tree[0].children).toHaveLength(0)
  })

  it('空输入返回空数组', () => {
    expect(buildFolderTree([])).toEqual([])
  })
})

describe('fmtSize', () => {
  it('各量级人类可读', () => {
    expect(fmtSize(0)).toBe('0 B')
    expect(fmtSize(512)).toBe('512 B')
    expect(fmtSize(2048)).toBe('2 KB')
    expect(fmtSize(1536)).toBe('1.5 KB')
    expect(fmtSize(10 * 1024 * 1024 * 1024)).toBe('10 GB')
  })

  it('非法输入按 0 处理', () => {
    expect(fmtSize(-5)).toBe('0 B')
    expect(fmtSize(NaN)).toBe('0 B')
  })
})

describe('previewKind', () => {
  it('图片/xmind/pdf/文本/下载 分流', () => {
    expect(previewKind('a.png', 'image')).toBe('image')
    expect(previewKind('导图.XMIND', 'other')).toBe('xmind')
    expect(previewKind('报告.pdf', 'doc')).toBe('pdf')
    expect(previewKind('README.md', 'doc')).toBe('text')
    expect(previewKind('script.ts', 'doc')).toBe('text')
    expect(previewKind('报表.xlsx', 'doc')).toBe('download')
    expect(previewKind('打包.zip', 'other')).toBe('download')
  })
})
