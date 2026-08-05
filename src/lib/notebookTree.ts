/**
 * 笔记本树(P16.1)。`notebooks.parent_id` 之上的纯逻辑,前后端共用
 * (worker 直接 import src/lib 是既有做法,见 worker/routes/pages.ts 引 blogSlug)。
 *
 * 结构与规则刻意跟文件管理的文件夹树保持一致(worker/routes/fm.ts):
 * 子孙收集、移动时的环检测、有子节点时禁止删除——那套已经跑了好几个版本,
 * 两边行为一样,用起来也不用学两遍。
 *
 * 两条容错是这个模块存在的主要理由,散在组件里迟早写漏:
 *   1. **父不存在就当根**。parent_id 指向一个已被删掉或数据不一致的笔记本时,
 *      它必须照常出现在顶层——笔记本可以放错位置,但绝不能从侧栏消失。
 *   2. **数据成环也不能吞节点**。环本不该出现(创建与移动都挡了),但备份恢复、
 *      并发写入都可能造出来;成环的那条链会被就地打断成根,而不是整条从树上失踪。
 */

export interface NotebookLike {
  id: number
  name: string
  /** null / undefined 均表示挂在根上 */
  parent_id?: number | null
}

export interface TreeNode<T extends NotebookLike> {
  nb: T
  /** 根为 0 */
  depth: number
  children: TreeNode<T>[]
}

/** 沿 parent_id 往上能不能走到头(走到不存在的父也算到头);成环则 false */
function resolvesToRoot(byId: Map<number, NotebookLike>, start: NotebookLike): boolean {
  const seen = new Set<number>([start.id])
  let cur = start.parent_id
  while (cur != null) {
    if (seen.has(cur)) return false
    const p = byId.get(cur)
    if (!p) return true
    seen.add(cur)
    cur = p.parent_id
  }
  return true
}

/** id -> 直接子节点 id 列表(与 fm.ts 收集文件夹子孙的做法同构) */
function childIndex(list: NotebookLike[]): Map<number, number[]> {
  const kids = new Map<number, number[]>()
  for (const nb of list) {
    if (nb.parent_id == null) continue
    const arr = kids.get(nb.parent_id)
    if (arr) arr.push(nb.id)
    else kids.set(nb.parent_id, [nb.id])
  }
  return kids
}

/**
 * 建树。**同级顺序原样沿用入参顺序**——服务端给的是 `ORDER BY updated_at DESC`,
 * 这一批不改排序规则,免得老用户的侧栏顺序无缘无故变了。要改就在调用处排。
 */
export function buildTree<T extends NotebookLike>(list: T[]): TreeNode<T>[] {
  const byId = new Map<number, NotebookLike>(list.map((n) => [n.id, n]))
  const nodes = new Map<number, TreeNode<T>>(list.map((n) => [n.id, { nb: n, depth: 0, children: [] }]))

  const roots: TreeNode<T>[] = []
  for (const nb of list) {
    const node = nodes.get(nb.id)!
    const parent = nb.parent_id != null ? nodes.get(nb.parent_id) : undefined
    if (parent && parent !== node && resolvesToRoot(byId, nb)) parent.children.push(node)
    else roots.push(node)
  }

  // 上面已保证挂出来的结构无环,这里可以放心递归
  const walk = (ns: TreeNode<T>[], d: number) => {
    for (const n of ns) {
      n.depth = d
      walk(n.children, d + 1)
    }
  }
  walk(roots, 0)
  return roots
}

/** id 的全部子孙(不含自己);顺序为广度无关的遍历序,只用于集合判断 */
export function descendantIds(list: NotebookLike[], id: number): number[] {
  const kids = childIndex(list)
  const out: number[] = []
  const seen = new Set<number>([id]) // 自己先占位,成环时不会绕回来
  const stack = [...(kids.get(id) || [])]
  while (stack.length > 0) {
    const cur = stack.pop()!
    if (seen.has(cur)) continue
    seen.add(cur)
    out.push(cur)
    for (const k of kids.get(cur) || []) stack.push(k)
  }
  return out
}

/** id 自己 + 全部子孙,给「显示所有子级文章」那类查询用 */
export function subtreeIds(list: NotebookLike[], id: number): number[] {
  return [id, ...descendantIds(list, id)]
}

/** 把 id 移到 newParentId 之下会不会造成环(移到自己身上、移进自己的子孙里) */
export function wouldCycle(list: NotebookLike[], id: number, newParentId: number | null | undefined): boolean {
  if (newParentId == null) return false
  if (newParentId === id) return true
  return descendantIds(list, id).includes(newParentId)
}

/** 从根到该笔记本的名字链,用于面包屑与「我的私有」列表里的归属路径 */
export function pathOf(list: NotebookLike[], id: number): string[] {
  const byId = new Map(list.map((n) => [n.id, n]))
  const out: string[] = []
  const seen = new Set<number>()
  let cur: number | null | undefined = id
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const nb = byId.get(cur)
    if (!nb) break
    out.unshift(nb.name)
    cur = nb.parent_id
  }
  return out
}

/**
 * 同一个父下面有没有另一本已经叫这个名字(P17.1 重命名用)。
 *
 * **不是禁止,只是提示。** 服务端没有唯一约束,同级重名不会让任何现有功能出错——
 * 它坏的是**以后**:P16.3.1 起 `/api/import` 按「从根到自己的完整路径」匹配笔记本,
 * 而两本同级同名会算出同一条路径,于是导入落进哪一本取决于 SQL 的行序。
 * 这个后果是延迟的、静默的,发现时早忘了当初重的名,所以要在改名那一刻说出来。
 *
 * 排除 selfId 自己(改成和原来一样的名字不算重名);大小写敏感、首尾空白已由调用方 trim。
 */
export function siblingNameTaken(
  list: NotebookLike[], selfId: number, name: string, parentId: number | null | undefined,
): boolean {
  const target = name.trim()
  if (!target) return false
  const parent = parentId ?? null
  return list.some((n) => n.id !== selfId && (n.parent_id ?? null) === parent && n.name === target)
}

/**
 * 该笔记本自己、或它的任一祖先,是不是私密笔记本(P16.5)。
 *
 * **私有性沿树向下继承,而且不允许在私有子树里挖公开的洞**:标了「内部资料」私有,
 * 而「内部资料/薪酬」不跟着私有,那就是个陷阱——你以为整棵锁了,实际漏一层,
 * 而侧栏一排锁图标里混一个没锁的根本看不出来。要放公开的东西就挪到私有子树外面。
 *
 * 注意这只决定**写入时的默认值**:事实源始终是 articles.is_private 那一列,
 * 所以博客发布、分享、备份、公开预检没有一处需要同时看两个地方。
 * 单篇笔记仍可显式取消私有(整理好了要发博客),但那必须是主动动作——忘了标不会漏。
 */
export function inPrivateBranch(list: (NotebookLike & { is_private?: number | null })[], id: number): boolean {
  const byId = new Map(list.map((n) => [n.id, n]))
  const seen = new Set<number>()
  let cur: number | null | undefined = id
  while (cur != null && !seen.has(cur)) {
    seen.add(cur)
    const nb = byId.get(cur)
    if (!nb) return false
    if (nb.is_private) return true
    cur = nb.parent_id
  }
  return false
}

/** 私有是自己标的,还是从上级继承来的(只有前者能在界面上取消) */
export function privacySource(
  list: (NotebookLike & { is_private?: number | null })[],
  id: number,
): 'self' | 'inherited' | 'none' {
  const self = list.find((n) => n.id === id)
  if (self?.is_private) return 'self'
  return inPrivateBranch(list, id) ? 'inherited' : 'none'
}
