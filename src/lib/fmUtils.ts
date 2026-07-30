// 文件管理页纯逻辑(tests/fmUtils.test.ts 覆盖);worker 侧(fm.ts/files.ts)也复用本文件

export interface FolderRow {
  id: number
  name: string
  parent_id: number | null
  is_private?: number
}

export interface FolderNode extends FolderRow {
  children: FolderNode[]
}

/**
 * 文件夹平铺行 → 树。接口层保证不会产生环(创建时父必须已存在、改父时校验祖先链),
 * 这里只做防御:父不存在(孤儿)或指向自己 → 提升为根;
 * 各层排序:私密根目录置顶,其余按名称(中文按拼音习惯 localeCompare)。
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
    list.sort((a, b) =>
      (Number(b.is_private || 0) - Number(a.is_private || 0)) || a.name.localeCompare(b.name, 'zh'))
    for (const n of list) sortLevel(n.children)
  }
  sortLevel(roots)
  return roots
}

/**
 * 私密文件夹子树:is_private 标记的根及其全部后代 id。
 * 私密性纯结构化——目录移进移出即改变归属,不存每文件/每子目录标志,不会漂移。
 */
export function collectPrivateIds(rows: FolderRow[]): Set<number> {
  const children = new Map<number, number[]>()
  const queue: number[] = []
  for (const r of rows) {
    if (r.is_private) queue.push(r.id)
    if (r.parent_id != null && r.parent_id !== r.id) {
      const list = children.get(r.parent_id) || []
      list.push(r.id)
      children.set(r.parent_id, list)
    }
  }
  const out = new Set<number>()
  while (queue.length > 0) {
    const id = queue.pop()!
    if (out.has(id)) continue
    out.add(id)
    for (const ch of children.get(id) || []) queue.push(ch)
  }
  return out
}

/** 分享有效期档位(seconds 为 null 表示永久) */
export const EXPIRY_PRESETS: { label: string; seconds: number | null }[] = [
  { label: '1 小时', seconds: 3600 },
  { label: '1 天', seconds: 86400 },
  { label: '3 天', seconds: 259200 },
  { label: '7 天', seconds: 604800 },
  { label: '1 个月', seconds: 2592000 },
  { label: '1 年', seconds: 31536000 },
  { label: '永久', seconds: null },
]

/** 分享剩余有效期展示:'永久' | '已过期' | 'N 天/小时/分钟'(now 可注入便于测试) */
export function fmtRemaining(expiresAt: string | null | undefined, now: number = Date.now()): string {
  if (!expiresAt) return '永久'
  const t = Date.parse(/[TZ]/.test(expiresAt) ? expiresAt : expiresAt.replace(' ', 'T') + 'Z')
  if (Number.isNaN(t)) return '永久'
  const diff = t - now
  if (diff <= 0) return '已过期'
  const days = Math.floor(diff / 86400000)
  if (days >= 1) return `${days} 天`
  const hours = Math.floor(diff / 3600000)
  if (hours >= 1) return `${hours} 小时`
  return `${Math.max(1, Math.floor(diff / 60000))} 分钟`
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

/**
 * 批量复制的副本名(P13.3):「报告.pdf」→「报告 副本.pdf」。
 * 反复复制不叠成「副本 副本 副本」,而是「副本 2」「副本 3」——否则复制三次就得到一个读不出来的名字。
 * 扩展名按最后一个点切,无扩展名的整串当主名。
 */
export function copyName(name: string): string {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  const m = base.match(/^(.*) 副本(?: (\d+))?$/)
  if (m) return `${m[1]} 副本 ${Number(m[2] || 1) + 1}${ext}`
  return `${base} 副本${ext}`
}
