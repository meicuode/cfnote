import { describe, it, expect } from 'vitest'
import {
  buildFolderTree, collectPrivateIds, fmtSize, fmtRemaining, previewKind, copyName,
  nextSelection, selectionSummary, showCheckbox, parseCheckboxMode,
} from '../src/lib/fmUtils'

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

  it('私密根目录置顶,其余按名称', () => {
    const tree = buildFolderTree([
      { id: 1, name: '安装包', parent_id: null },
      { id: 2, name: '我的私密文件夹', parent_id: null, is_private: 1 },
      { id: 3, name: '资料', parent_id: null },
    ])
    expect(tree.map((n) => n.name)).toEqual(['我的私密文件夹', '安装包', '资料'])
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

describe('collectPrivateIds', () => {
  it('私密根及其全部后代进入集合,非私密兄弟不受影响', () => {
    const ids = collectPrivateIds([
      { id: 1, name: '我的私密文件夹', parent_id: null, is_private: 1 },
      { id: 2, name: '证件', parent_id: 1 },
      { id: 3, name: '2026', parent_id: 2 },
      { id: 4, name: '公开资料', parent_id: null },
      { id: 5, name: '公开子目录', parent_id: 4 },
    ])
    expect([...ids].sort()).toEqual([1, 2, 3])
  })

  it('无私密目录返回空集合', () => {
    expect(collectPrivateIds([{ id: 1, name: 'a', parent_id: null }]).size).toBe(0)
    expect(collectPrivateIds([]).size).toBe(0)
  })

  it('自指行不死循环(防御)', () => {
    const ids = collectPrivateIds([{ id: 9, name: '自指私密', parent_id: 9, is_private: 1 }])
    expect([...ids]).toEqual([9])
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

describe('fmtRemaining', () => {
  const now = Date.parse('2026-07-24T12:00:00Z')

  it('空值为永久,过期为已过期', () => {
    expect(fmtRemaining(null, now)).toBe('永久')
    expect(fmtRemaining(undefined, now)).toBe('永久')
    expect(fmtRemaining('2026-07-24T11:59:59Z', now)).toBe('已过期')
    expect(fmtRemaining('2026-07-24T12:00:00Z', now)).toBe('已过期')
  })

  it('按剩余量级取整:天/小时/分钟', () => {
    expect(fmtRemaining('2026-07-27T12:00:00Z', now)).toBe('3 天')
    expect(fmtRemaining('2026-07-24T13:30:00Z', now)).toBe('1 小时')
    expect(fmtRemaining('2026-07-24T12:20:00Z', now)).toBe('20 分钟')
    expect(fmtRemaining('2026-07-24T12:00:30Z', now)).toBe('1 分钟')
  })

  it('兼容 D1 datetime("now") 的空格格式(按 UTC 解析)', () => {
    expect(fmtRemaining('2026-07-25 12:00:00', now)).toBe('1 天')
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

describe('copyName(P13.3 批量复制)', () => {
  it('副本名插在扩展名之前', () => {
    expect(copyName('报告.pdf')).toBe('报告 副本.pdf')
    expect(copyName('archive.tar.gz')).toBe('archive.tar 副本.gz')
  })

  it('反复复制加序号而不是叠「副本 副本」', () => {
    expect(copyName('报告 副本.pdf')).toBe('报告 副本 2.pdf')
    expect(copyName('报告 副本 2.pdf')).toBe('报告 副本 3.pdf')
    expect(copyName('报告 副本 9.pdf')).toBe('报告 副本 10.pdf')
  })

  it('没有扩展名的整串当主名', () => {
    expect(copyName('README')).toBe('README 副本')
    expect(copyName('README 副本')).toBe('README 副本 2')
  })

  it('以点开头的隐藏文件不被当成「全是扩展名」', () => {
    expect(copyName('.gitignore')).toBe('.gitignore 副本')
  })
})

describe('多选:资源管理器语义(P13.7)', () => {
  const ids = [10, 20, 30, 40, 50]
  const S = (arr: number[], anchor: number | null = null) => ({ sel: new Set(arr), anchor })
  const plain = { ctrl: false, shift: false }
  const ctrl = { ctrl: true, shift: false }
  const shift = { ctrl: false, shift: true }
  const both = { ctrl: true, shift: true }
  const out = (r: { sel: Set<number> }) => [...r.sel].sort((a, b) => a - b)

  it('单击只选这一行,清掉其他', () => {
    const r = nextSelection(ids, S([10, 20, 30]), 40, plain)
    expect(out(r)).toEqual([40])
    expect(r.anchor).toBe(40)
  })

  it('Ctrl 单击切换当前行,其余不动', () => {
    expect(out(nextSelection(ids, S([10, 30]), 20, ctrl))).toEqual([10, 20, 30])
    expect(out(nextSelection(ids, S([10, 20, 30]), 20, ctrl))).toEqual([10, 30])
  })

  it('Shift 连选一段并替换原选择,锚点不动', () => {
    const r = nextSelection(ids, S([50], 20), 40, shift)
    expect(out(r)).toEqual([20, 30, 40])
    // 锚点保持在 20,才能反复调整这一段的另一端
    expect(r.anchor).toBe(20)
    // 回头点更小的一端,取的是 10..20 而不是空段
    expect(out(nextSelection(ids, S([20, 30, 40], 20), 10, shift))).toEqual([10, 20])
  })

  it('Ctrl+Shift 把这一段追加进原选择', () => {
    expect(out(nextSelection(ids, S([50], 20), 40, both))).toEqual([20, 30, 40, 50])
  })

  it('没有锚点时的 Shift 退化为单击', () => {
    const r = nextSelection(ids, S([10, 20], null), 40, shift)
    expect(out(r)).toEqual([40])
    expect(r.anchor).toBe(40)
  })

  it('锚点已不在当前列表(筛选变了)时也退化为单击,不会选出空集', () => {
    const r = nextSelection(ids, S([10], 999), 30, shift)
    expect(out(r)).toEqual([30])
  })

  it('选中合计只算当前列表里的行', () => {
    const files = [{ id: 10, size: 100 }, { id: 20, size: 250 }, { id: 30, size: 0 }]
    expect(selectionSummary(files, new Set([10, 20, 999]))).toEqual({ count: 2, size: 350 })
    expect(selectionSummary(files, new Set())).toEqual({ count: 0, size: 0 })
  })
})

describe('复选框显示模式(P13.7)', () => {
  it('坏值与缺省一律回落 auto', () => {
    expect(parseCheckboxMode(null)).toBe('auto')
    expect(parseCheckboxMode('nope')).toBe('auto')
    expect(parseCheckboxMode('on')).toBe('on')
    expect(parseCheckboxMode('off')).toBe('off')
  })

  it('auto 只在触屏显示,on/off 一票决定', () => {
    expect(showCheckbox('auto', true)).toBe(true)
    expect(showCheckbox('auto', false)).toBe(false)
    expect(showCheckbox('on', false)).toBe(true)
    expect(showCheckbox('off', true)).toBe(false)
  })
})
