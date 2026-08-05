import { describe, it, expect } from 'vitest'
import { planImport, chunkBySize, CHUNK_FILES, type ImportFileLike } from '../src/lib/importPlan'

/** 选文件夹时每个 File 都带上从选中目录算起的相对路径 */
const inDir = (rel: string): ImportFileLike => ({ name: rel.split('/').pop() || rel, webkitRelativePath: rel })
/** 选单个文件时 webkitRelativePath 是空串 */
const pick = (name: string): ImportFileLike => ({ name, webkitRelativePath: '' })

/** 载荷里的 id 只在内部有意义,断言时按名字看更好读 */
function tree(plan: ReturnType<typeof planImport>): string[] {
  const byId = new Map(plan.notebooks.map((n) => [n.id, n]))
  const pathOf = (id: number): string => {
    const out: string[] = []
    let cur: number | null = id
    const seen = new Set<number>()
    while (cur != null && !seen.has(cur)) {
      seen.add(cur)
      const nb = byId.get(cur)
      if (!nb) break
      out.unshift(nb.name)
      cur = nb.parent_id
    }
    return out.join('/')
  }
  return plan.notebooks.map((n) => pathOf(n.id))
}

/** 每篇文章落在哪本笔记本里(按路径),用于断言落点 */
function placement(plan: ReturnType<typeof planImport>): Record<string, string> {
  const paths = tree(plan)
  const pathById = new Map(plan.notebooks.map((n, i) => [n.id, paths[i]]))
  const out: Record<string, string> = {}
  for (const a of plan.articles) out[a.title] = pathById.get(a.notebook_id) || '?'
  return out
}

describe('planImport', () => {
  it('目标笔记本发的是整条祖先链,不是它自己的名字', () => {
    // 这是 P16.3.1 引进的回归:服务端按「从根到自己」的完整路径匹配,
    // 只发 ['前端'] 的话会跟根上的「前端」比,对不上 → 在根上另建一本同名的
    const plan = planImport([inDir('导出/note.md')], ['技术', '前端'], true)
    expect(tree(plan)).toEqual(['技术', '技术/前端'])
    // 祖先链那两节不算新建——它们是用来对上号的
    expect(plan.willCreate).toBe(0)
  })

  it('选中的那层文件夹自己不建笔记本,它下面的文档直接进目标', () => {
    const plan = planImport([inDir('我的笔记/部署.md')], ['技术'], true)
    expect(tree(plan)).toEqual(['技术'])
    expect(placement(plan)).toEqual({ 部署: '技术' })
  })

  it('子目录建成子笔记本,同一个目录只建一次', () => {
    const plan = planImport(
      [inDir('nb/前端/a.md'), inDir('nb/前端/b.md'), inDir('nb/后端/c.md')],
      ['技术'], true,
    )
    expect(tree(plan)).toEqual(['技术', '技术/前端', '技术/后端'])
    expect(placement(plan)).toEqual({ a: '技术/前端', b: '技术/前端', c: '技术/后端' })
  })

  it('多层目录逐层建出来', () => {
    const plan = planImport([inDir('nb/技术/前端/深/a.md')], ['根'], true)
    expect(tree(plan)).toEqual(['根', '根/技术', '根/技术/前端', '根/技术/前端/深'])
    expect(plan.willCreate).toBe(3)
  })

  it('不同分支下的同名目录是两本,不会合并', () => {
    // 与服务端 P16.3.1 同一条规矩:`技术/归档` 与 `读书/归档` 不是一本
    const plan = planImport([inDir('nb/技术/归档/a.md'), inDir('nb/读书/归档/b.md')], ['根'], true)
    expect(tree(plan)).toEqual(['根', '根/技术', '根/技术/归档', '根/读书', '根/读书/归档'])
    expect(placement(plan)).toEqual({ a: '根/技术/归档', b: '根/读书/归档' })
  })

  it('保留结构时标题只剩文件名——路径已经由树表达了', () => {
    const plan = planImport([inDir('nb/技术/README.md'), inDir('nb/读书/README.md')], ['根'], true)
    expect(plan.articles.map((a) => a.title)).toEqual(['README', 'README'])
    // 标题一样、落点不同。服务端的去重键因此必须带上 notebook_id,
    // 否则第二篇会被判成重复而丢掉(P16.4 改的就是这个键)
    expect(plan.articles.map((a) => a.notebook_id)).toEqual([
      plan.notebooks.find((n) => n.name === '技术')!.id,
      plan.notebooks.find((n) => n.name === '读书')!.id,
    ])
  })

  it('不勾选保留结构:全部进目标笔记本,路径写回标题(P15.4 的老行为)', () => {
    const plan = planImport([inDir('nb/技术/README.md'), inDir('nb/读书/README.md')], ['根'], false)
    expect(tree(plan)).toEqual(['根'])
    expect(plan.willCreate).toBe(0)
    expect(plan.articles.map((a) => a.title)).toEqual(['技术/README', '读书/README'])
    expect(new Set(plan.articles.map((a) => a.notebook_id)).size).toBe(1)
  })

  it('选的是单个文件(没有相对路径):不建任何子笔记本', () => {
    const plan = planImport([pick('随手记.md')], ['技术'], true)
    expect(tree(plan)).toEqual(['技术'])
    expect(placement(plan)).toEqual({ 随手记: '技术' })
  })

  it('目标路径为空时产出空计划,绝不往根上凭空建一批笔记本', () => {
    const plan = planImport([inDir('nb/a/x.md')], [], true)
    expect(plan).toEqual({ notebooks: [], articles: [], willCreate: 0 })
  })

  it('同名目录在不同深度也各是各的', () => {
    const plan = planImport([inDir('nb/a/b/x.md'), inDir('nb/b/y.md')], ['根'], true)
    expect(tree(plan)).toEqual(['根', '根/a', '根/a/b', '根/b'])
    expect(placement(plan)).toEqual({ x: '根/a/b', y: '根/b' })
  })

  it('文章下标指回入参数组,正文由调用方去读', () => {
    const files = [inDir('nb/a.md'), inDir('nb/b.md')]
    const plan = planImport(files, ['根'], true)
    expect(plan.articles.map((a) => a.index)).toEqual([0, 1])
  })
})

describe('chunkBySize', () => {
  const sz = (n: number) => () => n

  it('按条数切', () => {
    const items = Array.from({ length: CHUNK_FILES * 2 + 3 }, (_, i) => i)
    const out = chunkBySize(items, sz(1))
    expect(out.map((c) => c.length)).toEqual([CHUNK_FILES, CHUNK_FILES, 3])
  })

  it('按累计大小切', () => {
    const out = chunkBySize([1, 2, 3, 4], sz(800), 100, 2000)
    expect(out.map((c) => c.length)).toEqual([2, 2])
  })

  it('单条自己就超上限时自成一片,不会卡死整批', () => {
    // 否则那一条永远进不去:cur 一直空、条件永远不满足,或者被无限往后推
    const out = chunkBySize([1, 2, 3], (x) => (x === 2 ? 9999 : 10), 100, 1000)
    expect(out).toEqual([[1], [2], [3]])
  })

  it('空数组给空结果,不产出一个空片', () => {
    expect(chunkBySize([], sz(1))).toEqual([])
  })

  it('大小算不出来(0/NaN)时退化成只按条数切,不至于每条一片', () => {
    const out = chunkBySize([1, 2, 3], () => NaN, 2, 1000)
    expect(out.map((c) => c.length)).toEqual([2, 1])
  })
})
