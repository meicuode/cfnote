import { describe, it, expect } from 'vitest'
import { buildTree, descendantIds, subtreeIds, wouldCycle, pathOf, inPrivateBranch, privacySource, siblingNameTaken } from '../src/lib/notebookTree'

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

describe('inPrivateBranch / privacySource', () => {
  // ERP笔记 ├ 内部资料(私密) └ 薪酬 / 销售管理
  const P = [
    { id: 1, name: 'ERP笔记', parent_id: null, is_private: 0 },
    { id: 2, name: '内部资料', parent_id: 1, is_private: 1 },
    { id: 3, name: '薪酬', parent_id: 2, is_private: 0 },
    { id: 4, name: '销售管理', parent_id: 1, is_private: 0 },
  ]

  it('自己标了私密就是私密', () => {
    expect(inPrivateBranch(P, 2)).toBe(true)
    expect(privacySource(P, 2)).toBe('self')
  })

  it('私有沿树向下继承:子孙不必自己标也算私密', () => {
    expect(inPrivateBranch(P, 3)).toBe(true)
    expect(privacySource(P, 3)).toBe('inherited')
  })

  it('私有不向上蔓延:父本与旁支不受影响', () => {
    expect(inPrivateBranch(P, 1)).toBe(false)
    expect(inPrivateBranch(P, 4)).toBe(false)
    expect(privacySource(P, 4)).toBe('none')
  })

  it('子本把自己标成非私密也挖不出公开的洞', () => {
    // is_private 显式为 0,但祖先私密——仍然算在私有分支里
    expect(inPrivateBranch(P, 3)).toBe(true)
  })

  it('id 不存在时不算私密,但也不能报错', () => {
    expect(inPrivateBranch(P, 999)).toBe(false)
    expect(privacySource(P, 999)).toBe('none')
  })

  it('成环时不会死循环', () => {
    const cyc = [
      { id: 1, name: '甲', parent_id: 2, is_private: 0 },
      { id: 2, name: '乙', parent_id: 1, is_private: 0 },
    ]
    expect(inPrivateBranch(cyc, 1)).toBe(false)
  })

  it('环里只要有一本私密,链上的都算私密(安全方向宁可多判)', () => {
    const cyc = [
      { id: 1, name: '甲', parent_id: 2, is_private: 0 },
      { id: 2, name: '乙', parent_id: 1, is_private: 1 },
    ]
    expect(inPrivateBranch(cyc, 1)).toBe(true)
  })
})

describe('siblingNameTaken(P17.1 重命名的同级重名提示)', () => {
  // 根: ERP笔记 / 随手记;ERP笔记 下: 销售管理 / 采购管理
  it('同一个父下面已有同名的 → true', () => {
    expect(siblingNameTaken(TREE, 5, '销售管理', 1)).toBe(true)
  })

  it('改成和自己原来一样的名字不算重名', () => {
    // 否则一进编辑框就亮警告,而用户什么都还没改
    expect(siblingNameTaken(TREE, 2, '销售管理', 1)).toBe(false)
  })

  it('不同父下面同名互不相干', () => {
    // 「ERP笔记/销售管理」与根上的「销售管理」是两条不同的路径
    expect(siblingNameTaken(TREE, 9, '销售管理', null)).toBe(false)
  })

  it('根上的重名照样算', () => {
    expect(siblingNameTaken(TREE, 1, '随手记', null)).toBe(true)
  })

  it('首尾空白不影响判断', () => {
    expect(siblingNameTaken(TREE, 5, '  销售管理  ', 1)).toBe(true)
  })

  it('空名字不判重名(它由「不提交」那条规则拦下)', () => {
    expect(siblingNameTaken(TREE, 5, '   ', 1)).toBe(false)
  })

  it('大小写与全半角不同就是不同的名字', () => {
    // 不做归一:笔记本名是用户写的字面量,「ERP」与「erp」是两个名字。
    // 归一之后「为什么提示重名,明明不一样」比漏一次提示更难解释
    const T = [{ id: 1, name: 'ERP', parent_id: null }, { id: 2, name: 'erp', parent_id: null }]
    expect(siblingNameTaken(T, 1, 'erp', null)).toBe(true)   // 与 id=2 撞上
    expect(siblingNameTaken(T, 3, 'Erp', null)).toBe(false)  // 两本都不是它
  })

  it('parent_id 的 undefined 与 null 当成同一个「根」', () => {
    // 侧栏传的是 nb.parent_id,老数据里可能是 undefined
    const T = [{ id: 1, name: '甲', parent_id: null }, { id: 2, name: '乙', parent_id: undefined as any }]
    expect(siblingNameTaken(T, 2, '甲', undefined)).toBe(true)
  })
})
