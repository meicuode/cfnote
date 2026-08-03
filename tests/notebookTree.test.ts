import { describe, it, expect } from 'vitest'
import { buildTree, descendantIds, subtreeIds, wouldCycle, pathOf } from '../src/lib/notebookTree'

const nb = (id: number, name: string, parent_id: number | null = null) => ({ id, name, parent_id })

/** ERP笔记 ├ 销售管理 ├ 订单流程 └ 异常处理 / 采购管理;另有一本独立的「随手记」 */
const TREE = [
  nb(1, 'ERP笔记'),
  nb(2, '销售管理', 1),
  nb(3, '订单流程', 2),
  nb(4, '异常处理', 3),
  nb(5, '采购管理', 1),
  nb(9, '随手记'),
]

/** 只取名字,方便断言形状 */
const shape = (ns: ReturnType<typeof buildTree>): any =>
  ns.map((n) => (n.children.length ? { [n.nb.name]: shape(n.children) } : n.nb.name))

describe('buildTree', () => {
  it('按 parent_id 建出层级,depth 从 0 起算', () => {
    const roots = buildTree(TREE)
    expect(shape(roots)).toEqual([
      { ERP笔记: [{ 销售管理: [{ 订单流程: ['异常处理'] }] }, '采购管理'] },
      '随手记',
    ])
    expect(roots[0].depth).toBe(0)
    expect(roots[0].children[0].depth).toBe(1)
    expect(roots[0].children[0].children[0].children[0].depth).toBe(3)
  })

  it('同级顺序原样沿用入参顺序,不自作主张排序', () => {
    const roots = buildTree([nb(1, '甲'), nb(3, '丙', 1), nb(2, '乙', 1)])
    expect(roots[0].children.map((c) => c.nb.name)).toEqual(['丙', '乙'])
  })

  it('父不存在时挂到根,不能让笔记本从侧栏消失', () => {
    const roots = buildTree([nb(1, '孤儿', 999), nb(2, '正常')])
    expect(shape(roots)).toEqual(['孤儿', '正常'])
  })

  it('parent_id 指向自己时挂到根', () => {
    expect(shape(buildTree([nb(1, '自环', 1)]))).toEqual(['自环'])
  })

  it('数据成环时就地打断成根,一个节点都不吞', () => {
    // 甲→乙→甲。创建与移动都挡了环,但备份恢复/并发写入可能造出来
    const roots = buildTree([nb(1, '甲', 2), nb(2, '乙', 1), nb(3, '丙')])
    expect(shape(roots).sort()).toEqual(['丙', '乙', '甲'])
  })

  it('空表返回空数组', () => {
    expect(buildTree([])).toEqual([])
  })
})

describe('descendantIds / subtreeIds', () => {
  it('收集全部子孙,不含自己', () => {
    expect(descendantIds(TREE, 1).sort()).toEqual([2, 3, 4, 5])
    expect(descendantIds(TREE, 2).sort()).toEqual([3, 4])
    expect(descendantIds(TREE, 4)).toEqual([])
  })

  it('subtreeIds 含自己,给「显示所有子级文章」的 IN 查询用', () => {
    expect(subtreeIds(TREE, 2).sort()).toEqual([2, 3, 4])
    expect(subtreeIds(TREE, 9)).toEqual([9])
  })

  it('成环的数据不会死循环', () => {
    const cyc = [nb(1, '甲', 2), nb(2, '乙', 1)]
    expect(descendantIds(cyc, 1)).toEqual([2])
  })
})

describe('wouldCycle', () => {
  it('移到根永远安全', () => {
    expect(wouldCycle(TREE, 2, null)).toBe(false)
    expect(wouldCycle(TREE, 2, undefined)).toBe(false)
  })

  it('移到自己身上算环', () => {
    expect(wouldCycle(TREE, 2, 2)).toBe(true)
  })

  it('移进自己的子孙里算环', () => {
    expect(wouldCycle(TREE, 2, 3)).toBe(true)
    expect(wouldCycle(TREE, 1, 4)).toBe(true)
  })

  it('移到别的分支、或移到自己的父/祖先下都不算环', () => {
    expect(wouldCycle(TREE, 5, 3)).toBe(false)
    expect(wouldCycle(TREE, 4, 1)).toBe(false)
    expect(wouldCycle(TREE, 9, 4)).toBe(false)
  })
})

describe('pathOf', () => {
  it('给出从根到该本的名字链', () => {
    expect(pathOf(TREE, 4)).toEqual(['ERP笔记', '销售管理', '订单流程', '异常处理'])
    expect(pathOf(TREE, 1)).toEqual(['ERP笔记'])
  })

  it('id 不存在时返回空数组', () => {
    expect(pathOf(TREE, 999)).toEqual([])
  })

  it('父不存在时链在断点处收住', () => {
    expect(pathOf([nb(1, '孤儿', 999)], 1)).toEqual(['孤儿'])
  })

  it('成环时不会死循环', () => {
    const cyc = [nb(1, '甲', 2), nb(2, '乙', 1)]
    expect(pathOf(cyc, 1)).toEqual(['乙', '甲'])
  })
})
