// 文件管理页纯逻辑(tests/fmUtils.test.ts 覆盖)

export interface FolderRow {
  id: number
  name: string
  parent_id: number | null
}

export interface FolderNode extends FolderRow {
  children: FolderNode[]
}

/**
 * 文件夹平铺行 → 树。接口层保证不会产生环(创建时父必须已存在、删除要求空目录、不支持改父),
 * 这里只做防御:父不存在(孤儿)或指向自己 → 提升为根;各层按名称排序(中文按拼音习惯 localeCompare)。
 */
export function buildFolderTree(rows: FolderRow[]): FolderNode[] {
  const byId = new Map<number, FolderNode>()
  for (const r of rows) byId.set(r.id, { ...r, children: [] })
  const roots: FolderNode[] = []
  for (const node of byId.values()) {
    const parent = node.parent_id != null ? byId.get(node.parent_id) : undefined
    if (!parent || parent === node) roots.push(node)
    else parent.children.push(node)
  }
  const sortLevel = (list: FolderNode[]) => {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
    for (const n of list) sortLevel(n.children)
  }
  sortLevel(roots)
  return roots
}

/** 字节数 → 人类可读(1 位小数,整数不带小数点) */
export function fmtSize(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  const s = v >= 100 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1)
  return `${s} ${units[i]}`
}

/** 预览方式判定:文本类弹窗渲染,pdf 交给浏览器,图片/xmind 由调用方特判,其余下载 */
export type PreviewKind = 'image' | 'xmind' | 'text' | 'pdf' | 'download'

const TEXT_EXT = /\.(md|markdown|txt|csv|json|ya?ml|xml|log|jsx?|tsx?|py|java|go|rs|c|cpp|h|sh|sql|html?|css)$/i

export function previewKind(name: string, category: string): PreviewKind {
  if (category === 'image') return 'image'
  if (/\.xmind$/i.test(name)) return 'xmind'
  if (/\.pdf$/i.test(name)) return 'pdf'
  if (TEXT_EXT.test(name)) return 'text'
  return 'download'
}
