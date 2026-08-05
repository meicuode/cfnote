/**
 * 本地导入时从选中的文件推导笔记标题(P15.4)。
 *
 * 选文件夹时浏览器会把整棵树都交出来,而 File.name 只有基名 —— 子文件夹里的
 * index.md / README.md 撞在一起,列表里就是并排几个同名笔记,认不出谁是谁。
 * 服务端按「标题 + 内容哈希」去重(worker/routes/system.ts),内容不同的还是都能进来,
 * 但同名同内容的那种(每个子目录各放一份一样的 README.md)会被判重跳过,那是真丢。
 *
 * 所以标题带上相对路径,但**剥掉第一段**:第一段就是用户选中的那个文件夹本身,
 * 每一篇标题里都重复它一遍没有意义。根目录下的文件因此仍然只有文件名,
 * 跟改造前完全一样 —— 斜杠只出现在真正来自子目录的笔记上。
 *
 * 选单个文件时 webkitRelativePath 是空串,自然走回 name。
 *
 * **P16.4 之后这只是「不保留结构」那条分支的规则**:默认改成把目录建成笔记本树
 * (src/lib/importPlan.ts),标题就只剩文件名了——路径由树表达,不必再挤进标题。
 * 那条路径下的去重键也换成了 notebook_id + 标题 + 内容哈希,不然各目录下同名同内容的
 * README.md 会互相判重,正是上面这段警告的情形。
 */

/** 认得的文档类型。选文件时的过滤(ImportDialog)与去扩展名共用同一份,免得两边各写一遍 */
export const DOC_EXT = /\.(md|markdown|txt)$/i

/** 去掉文档扩展名;形如 ".md" 的去完什么都不剩,退回原名 */
export function docStem(base: string): string {
  return base.replace(DOC_EXT, '') || base
}

/**
 * 相对路径里的**目录段**:剥掉第一段(选中的文件夹自己)与最后一段(文件名)。
 * 不足两段 = 选的是单个文件,没有目录层级。P16.4 建笔记本树用的就是它。
 */
export function dirSegments(file: { name: string; webkitRelativePath?: string }): string[] {
  // webkitRelativePath 一律用正斜杠分隔,Windows 上也是,不必处理反斜杠
  const rel = String(file.webkitRelativePath || '')
  const segs = rel ? rel.split('/').filter(Boolean) : []
  return segs.length >= 2 ? segs.slice(1, -1) : []
}

export function importTitle(file: { name: string; webkitRelativePath?: string }): string {
  const name = String(file.name || '')
  const rel = String(file.webkitRelativePath || '')
  const segs = rel ? rel.split('/').filter(Boolean) : []
  // 至少要有「根目录 + 文件」两段才谈得上剥根;不足两段说明不是文件夹选择
  const parts = segs.length >= 2 ? segs.slice(1) : [name]

  // 扩展名只能从最后一段(文件名)去掉,目录段一律原样保留。
  // 拼好整条路径再去扩展名是错的:"sub/.markdown" 会剩下一个吊着斜杠的 "sub/",
  // 而它非空,「什么都不剩就退回原名」那道兜底根本接不住
  const base = parts.pop() || name
  return [...parts, docStem(base)].join('/')
}
