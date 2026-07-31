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

// ---- 多选(P13.7):Windows 资源管理器语义 ----
// 之所以把它抽成纯函数:四种修饰键组合 × 有无锚点 × 越界,靠手点很难穷举,
// 而选错行的后果是「批量删除删掉了没打算删的那几个」。

export interface ClickMods {
  /** Ctrl(Windows)或 ⌘(macOS) */
  ctrl: boolean
  shift: boolean
}

export interface SelectionState {
  sel: Set<number>
  /** 锚点:Shift 连选的起点。Shift 点击不移动它,这样可以反复调整同一段的另一端 */
  anchor: number | null
}

/**
 * 点击某一行之后的新选择。ids 是当前列表的**显示顺序**(连选按屏幕上看到的顺序取段)。
 *
 * - 单击:只选这一行(清掉其他)
 * - Ctrl+单击:切换这一行,其余不变
 * - Shift+单击:锚点到该行这一段,**替换**原选择
 * - Ctrl+Shift+单击:这一段**追加**进原选择
 * - 没有锚点时的 Shift 退化为单击(否则第一次按 Shift 会什么都选不中)
 */
export function nextSelection(
  ids: number[], state: SelectionState, clicked: number, mods: ClickMods,
): SelectionState {
  const { sel, anchor } = state
  if (mods.shift && anchor != null) {
    const a = ids.indexOf(anchor)
    const b = ids.indexOf(clicked)
    if (a >= 0 && b >= 0) {
      const [lo, hi] = a < b ? [a, b] : [b, a]
      const range = ids.slice(lo, hi + 1)
      // Ctrl+Shift 追加;纯 Shift 替换。锚点保持不动
      return { sel: new Set(mods.ctrl ? [...sel, ...range] : range), anchor }
    }
  }
  if (mods.ctrl) {
    const next = new Set(sel)
    if (next.has(clicked)) next.delete(clicked)
    else next.add(clicked)
    return { sel: next, anchor: clicked }
  }
  return { sel: new Set([clicked]), anchor: clicked }
}

/** 选中项的合计(底部状态栏用);id 不在当前列表里的直接忽略 */
export function selectionSummary(files: { id: number; size: number }[], sel: Set<number>): { count: number; size: number } {
  let count = 0
  let size = 0
  for (const f of files) {
    if (!sel.has(f.id)) continue
    count++
    size += Number(f.size) || 0
  }
  return { count, size }
}

// ---- 复选框显示模式(P13.7)----
// 存 localStorage 而不是 settings 表:它是**每台设备**的显示偏好——
// 桌面用 Ctrl/Shift 点选、手机没有修饰键必须给复选框,同一个账号两台设备的答案本来就不同;
// 而且 settings 存在服务端的话,每次打开文件管理都要多打一次 /api/settings。
// 开关本身仍然放在「设置」面板里(那是找它的地方),只是落盘在本机。

export type CheckboxMode = 'auto' | 'on' | 'off'

export const FM_CHECKBOX_KEY = 'cfnote-fm-checkbox'

export function parseCheckboxMode(v: unknown): CheckboxMode {
  return v === 'on' || v === 'off' ? v : 'auto'
}

/**
 * 这台设备到底显不显示复选框。
 * coarsePointer 由调用方用 matchMedia('(pointer: coarse)') 取——按**指针类型**而不是窗口宽度判断:
 * 桌面把窗口拖窄了 Ctrl 照样能按,而平板即使横屏也没有修饰键。
 */
export function showCheckbox(mode: CheckboxMode, coarsePointer: boolean): boolean {
  if (mode === 'on') return true
  if (mode === 'off') return false
  return coarsePointer
}
