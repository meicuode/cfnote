import { useCallback, useEffect, useRef, useState, lazy, Suspense, type ReactNode } from 'react'
import ConfirmDialog from './ConfirmDialog'
import {
  buildFolderTree, collectPrivateIds, fmtSize, fmtRemaining, previewKind, EXPIRY_PRESETS,
  nextSelection, selectionSummary, showCheckbox, parseCheckboxMode, FM_CHECKBOX_KEY, menuPosition,
  type FolderNode,
} from '../lib/fmUtils'
import type { FmView, UseFileManager } from '../hooks/useFileManager'

const XmindViewer = lazy(() => import('./XmindViewer'))

// 文件管理页(P8.2,见 docs/file-manager.md):管理应用内全部附件。
// P11.5 起内联展示;P11.6 起左栏(全部/未引用/笔记附件/我的文件夹)上移为应用侧栏二级菜单
// (见 FileManagerNav.tsx),本组件只负责右侧:分类筛选+名称搜索+列表(预览/复制链接/重命名/移动/删除),
// 顶部统计与扫描登记/上传。overview 与文件夹增删改由 useFileManager 共享。
// 选择语义与右键菜单见 P13.7 / P13.8(判定与落点在 src/lib/fmUtils.ts,可单测)。

interface Props {
  token: string
  onClose: () => void
  /** 当前子视图(与 URL 同步,由 Layout 持有) */
  view: FmView
  onChangeView: (v: FmView) => void
  /** 与侧栏二级菜单共享的 overview / 文件夹操作 */
  fm: UseFileManager
  /** 打开设置面板并定位到「文件」那一节(P13.7 的复选框开关在那里) */
  onOpenSettings?: () => void
}

interface FmFile {
  id: number
  key: string
  name: string
  size: number
  category: 'image' | 'doc' | 'other'
  content_type: string | null
  folder_id: number | null
  share_token: string | null
  share_expires_at: string | null
  created_at: string
  updated_at: string
  url: string
  thumb: string | null
  ref_count: number
  pub_count: number
  is_private_file: boolean
}

interface RefItem {
  id: number
  title: string
  is_public: number
  is_private: number
  updated_at: string
  notebook: string | null
}

const CATE_LABEL: Record<string, string> = { image: '图片', doc: '文档', other: '其他' }
const R2_FREE = 10 * 1024 * 1024 * 1024

// 右键菜单(P13.8)。高度按条目估算而不是渲染后测量:估算够准就能定出翻转方向,
// 而「先渲染再量再挪」会闪一帧。数字对应下面的 py-1 / py-1.5 / my-1 三个类。
const MENU_W = 184
const MENU_PAD = 8
const MENU_ITEM_H = 32
const MENU_SEP_H = 9
const MENU_HEAD_H = 28

type MenuItem =
  | { key: string; sep: true }
  | { key: string; icon: string; label: string; danger?: boolean; onClick: () => void }

// 服务端时间统一 UTC(datetime('now') 无时区尾巴),补 Z 再按本地时区展示
const fmtDateTime = (s: string) => {
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime())
    ? s
    : d.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

let uploadUid = 0

export default function FileManager({ token, onClose, view, onChangeView, fm, onOpenSettings }: Props) {
  const { overview, reloadOverview, notice, flash } = fm
  const [category, setCategory] = useState<'all' | 'image' | 'doc' | 'other'>('all')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [files, setFiles] = useState<FmFile[] | null>(null)
  const [scanBusy, setScanBusy] = useState(false)
  // 上传占位:列表顶部逐个显示上传中的文件行,完成一个消掉一个
  const [uploadingItems, setUploadingItems] = useState<{ uid: number; name: string; size: number }[]>([])

  const [preview, setPreview] = useState<
    | { type: 'image'; url: string; name: string }
    | { type: 'xmind'; url: string; name: string }
    | { type: 'text'; name: string; text: string }
    | null
  >(null)
  const [renameTarget, setRenameTarget] = useState<FmFile | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [moveTarget, setMoveTarget] = useState<FmFile | null>(null)
  const [refsDialog, setRefsDialog] = useState<{ file: FmFile; refs: RefItem[] } | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ file: FmFile; refs: RefItem[] } | null>(null)
  // 分享对话框:对着一份本地文件快照操作,生成/取消后同步回列表
  const [shareDialog, setShareDialog] = useState<FmFile | null>(null)
  const [sharePreset, setSharePreset] = useState<number | null>(604800)
  const [shareBusy, setShareBusy] = useState(false)

  // 多选与批量操作(P13.3;P13.7 改为资源管理器语义)。anchor 是 Shift 连选的起点
  const [sel, setSel] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [batchBusy, setBatchBusy] = useState(false)
  const [batchMsg, setBatchMsg] = useState('')
  // 批量删除撞上「仍被笔记引用」时,服务端回一份名单让人确认
  const [batchDel, setBatchDel] = useState<{ id: number; name: string; refs: number }[] | null>(null)
  // 批量移动/复制的目标目录选择弹窗
  const [batchMove, setBatchMove] = useState<'move' | 'copy' | null>(null)
  // 右键菜单(P13.8):file 为 null 表示在列表空白处右键
  const [menu, setMenu] = useState<{ x: number; y: number; file: FmFile | null } | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const api = useCallback(
    async (path: string, init?: RequestInit): Promise<any> => {
      const res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers as any) },
      })
      return res.json()
    },
    [token]
  )

  const loadFiles = useCallback(async () => {
    const p = new URLSearchParams({ view: view.kind })
    if (view.kind === 'notebook') p.set('notebook', String(view.id))
    if (view.kind === 'folder') p.set('folder', String(view.id))
    if (category !== 'all') p.set('category', category)
    if (qDebounced) p.set('q', qDebounced)
    const j = await api(`/api/fm/files?${p}`).catch(() => null)
    setFiles(j?.ok ? j.data.files : [])
  }, [api, view, category, qDebounced])

  // overview 由 Layout 在进入文件管理时统一加载(侧栏二级菜单与这里共用同一份)
  // fm.tick:侧栏做完文件夹移动等结构性改动后自增,这里据此重拉文件
  useEffect(() => { setFiles(null); loadFiles() }, [loadFiles, fm.tick])
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  // 注:P11.5 改为内联模块后不再监听 Esc 关闭整个视图——搜索框里按 Esc 会误关工作区。
  // 各子弹窗(重命名/移动/分享等)自身的 Esc 关闭仍在各自处理。

  // 刷新:文件列表 + overview(后者驱动侧栏二级菜单的计数与文件夹树)
  const refresh = useCallback(() => { reloadOverview(); loadFiles() }, [reloadOverview, loadFiles])

  // ---- 多选与批量操作(P13.3)----

  // 换视图/换筛选/搜索后清空选中:留着上一屏的选中项,批量操作会作用在看不见的文件上
  useEffect(() => { setSel(new Set()); setAnchor(null); setMenu(null) }, [view, category, qDebounced])

  const selectedFiles = (files || []).filter((f) => sel.has(f.id))
  const allChecked = !!files && files.length > 0 && files.every((f) => sel.has(f.id))
  const summary = selectionSummary(files || [], sel)

  // 复选框显示模式(P13.7):存本机,开关在「设置 → 文件管理」。
  // 触屏设备默认给复选框——那里没有 Ctrl/Shift,没有它就完全没法多选。
  const [cbMode, setCbMode] = useState(() =>
    parseCheckboxMode(typeof localStorage !== 'undefined' ? localStorage.getItem(FM_CHECKBOX_KEY) : null))
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  const withCheckbox = showCheckbox(cbMode, coarse)
  // 从设置面板改完切回来时同步(两个面板不同时挂载,重挂载即重读;storage 事件管跨标签页)
  useEffect(() => {
    const sync = () => setCbMode(parseCheckboxMode(localStorage.getItem(FM_CHECKBOX_KEY)))
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  /** 点某一行:单击独选、Ctrl 切换、Shift 连选一段、Ctrl+Shift 追加一段(逻辑在 fmUtils 里可单测) */
  const clickRow = (f: FmFile, e: React.MouseEvent) => {
    const ids = (files || []).map((x) => x.id)
    const next = nextSelection(ids, { sel, anchor }, f.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
    setSel(next.sel)
    setAnchor(next.anchor)
  }

  /** 复选框那一列(触屏 / 手工开启时):点它永远只切换这一个,不受修饰键影响 */
  const toggleOne = (f: FmFile) => {
    setSel((cur) => {
      const next = new Set(cur)
      if (next.has(f.id)) next.delete(f.id)
      else next.add(f.id)
      return next
    })
    setAnchor(f.id)
  }

  const toggleAll = () => {
    setSel(allChecked ? new Set() : new Set((files || []).map((f) => f.id)))
    setAnchor(null)
  }

  // Ctrl/⌘+A 全选、Esc 清空。输入框里不拦截——那时候用户要选的是文字
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 菜单开着时 Esc 只关菜单、不清选择;这一条放在输入框判断之前——
      // 在搜索框里打字时右键了某一行,焦点仍在输入框,那时候 Esc 也该先把菜单收掉
      if (e.key === 'Escape' && menu) { setMenu(null); return }
      const el = e.target as HTMLElement | null
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
      if (typing) return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        if (!files || files.length === 0) return
        e.preventDefault()
        setSel(new Set(files.map((f) => f.id)))
        setAnchor(null)
      } else if (e.key === 'Escape' && sel.size > 0) {
        setSel(new Set())
        setAnchor(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [files, sel.size, menu])

  // 菜单开着时窗口尺寸变化/失焦就收起。「点别处关闭」交给下面那块透明遮罩,
  // 不用全局监听:mousedown 和 click 是两个独立事件,在捕获阶段吞掉前者并不能阻止后者
  // 落到某一行上顺手改掉选择,而补一个一次性的 click 拦截又会和 effect 的清理时机赛跑。
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const flashBatch = (msg: string) => {
    setBatchMsg(msg)
    setTimeout(() => setBatchMsg(''), 5000)
  }

  /** 批量操作统一入口:一次请求打完,不在前端循环打 N 次(N 个文件就是 N 次计费请求) */
  const runBatch = async (op: 'move' | 'delete' | 'copy', opts: { ids?: number[]; folder_id?: number | null; force?: boolean } = {}) => {
    const ids = opts.ids ?? [...sel]
    if (ids.length === 0) return
    setBatchBusy(true)
    const j = await api('/api/fm/files/batch', {
      method: 'POST',
      body: JSON.stringify({ op, ids, folder_id: opts.folder_id, force: opts.force }),
    }).catch(() => null)
    setBatchBusy(false)
    if (!j?.ok) return flashBatch(j?.error || '操作失败')
    const d = j.data || {}
    if (d.needs_force) { setBatchDel(d.referenced); return }
    if (op === 'move') {
      flashBatch(`已移动 ${d.moved} 个文件` + (d.revoked_shares > 0 ? `;其中 ${d.revoked_shares} 个移入私密文件夹,原分享已取消` : ''))
    } else if (op === 'delete') {
      flashBatch(`已删除 ${d.deleted} 个文件`)
    } else {
      const skip = (d.skipped || []) as { name: string; reason: string }[]
      flashBatch(`已复制 ${d.copied} 个文件` + (skip.length > 0 ? `;跳过 ${skip.length} 个(${skip.map((s) => `${s.name}:${s.reason}`).join('、')})` : ''))
    }
    setSel(new Set())
    setBatchDel(null)
    setBatchMove(null)
    refresh()
  }

  /** 批量复制链接:零成本,而且多半比复制文件本体更常用 */
  const copySelectedLinks = async () => {
    const urls = selectedFiles.map((f) => new URL(f.url, window.location.origin).href).join('\n')
    try {
      await navigator.clipboard.writeText(urls)
      flashBatch(`已复制 ${selectedFiles.length} 条链接到剪贴板`)
    } catch {
      flashBatch('复制失败:浏览器拒绝了剪贴板访问')
    }
  }

  // 拖拽:把选中的文件拖到左侧目录树。若拖的是未选中的行,则先选中它再拖(与资源管理器一致)
  const dragIds = (f: FmFile): number[] => (sel.has(f.id) ? [...sel] : [f.id])
  const onRowDragStart = (f: FmFile, e: React.DragEvent) => {
    const ids = dragIds(f)
    if (!sel.has(f.id)) { setSel(new Set([f.id])); setAnchor(f.id) }
    fm.setDraggingFiles(true)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('application/x-cfnote-files', JSON.stringify(ids))
    // 纯文本兜底:某些浏览器不给自定义 type 的 dragover 读数据,落地时以它为准
    e.dataTransfer.setData('text/plain', ids.join(','))
  }
  // 松手或按 Esc 放弃都会触发 dragend,侧栏那块虚线落点据此收起
  const onRowDragEnd = () => fm.setDraggingFiles(false)

  // ---- 右键菜单(P13.8)----
  // 右键一个**未选中**的行:先把选择替换成它(资源管理器就是这样);右键选中集里的行则整段保持。
  // 这样菜单永远作用在 sel 上,不必再引入一个「右键目标」的平行状态去和拖拽、底部状态栏同步。
  const onRowContextMenu = (f: FmFile, e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!sel.has(f.id)) { setSel(new Set([f.id])); setAnchor(f.id) }
    setMenu({ x: e.clientX, y: e.clientY, file: f })
  }

  // 行会 stopPropagation,所以能冒泡到列表容器的一律算空白处
  const onEmptyContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, file: null })
  }

  // ---- 操作 ----

  const downloadFile = (f: FmFile) => {
    const a = document.createElement('a')
    a.href = f.url
    a.download = f.name
    a.click()
  }

  const openPreview = async (f: FmFile) => {
    const kind = previewKind(f.name, f.category)
    if (kind === 'image') setPreview({ type: 'image', url: f.url, name: f.name })
    else if (kind === 'xmind') setPreview({ type: 'xmind', url: f.url, name: f.name })
    else if (kind === 'pdf') window.open(f.url, '_blank')
    else if (kind === 'text') {
      try {
        const res = await fetch(f.url)
        const text = await res.text()
        setPreview({ type: 'text', name: f.name, text: text.length > 500_000 ? text.slice(0, 500_000) + '\n…(过大截断)' : text })
      } catch {
        flash('读取文件失败')
      }
    } else {
      downloadFile(f)
    }
  }

  const copyLink = async (f: FmFile) => {
    try {
      await navigator.clipboard.writeText(location.origin + f.url)
      flash('链接已复制')
    } catch {
      flash('复制失败')
    }
  }

  const fetchRefs = async (f: FmFile): Promise<RefItem[]> => {
    const j = await api(`/api/fm/files/${f.id}/refs`).catch(() => null)
    return j?.ok ? j.data.refs : []
  }

  const submitRename = async () => {
    if (!renameTarget || !renameVal.trim()) return
    const j = await api(`/api/fm/files/${renameTarget.id}`, { method: 'PUT', body: JSON.stringify({ name: renameVal.trim() }) })
    if (!j?.ok) flash(j?.error || '重命名失败')
    setRenameTarget(null)
    refresh()
  }

  const submitMove = async (folderId: number | null) => {
    if (!moveTarget) return
    const j = await api(`/api/fm/files/${moveTarget.id}`, { method: 'PUT', body: JSON.stringify({ folder_id: folderId }) })
    if (!j?.ok) flash(j?.error || '移动失败')
    else if (j.data?.revoked_shares > 0) flash('已移入私密文件夹,原分享已取消')
    setMoveTarget(null)
    refresh()
  }

  const submitDelete = async () => {
    if (!deleteTarget) return
    const force = deleteTarget.refs.length > 0 ? '?force=1' : ''
    const j = await api(`/api/fm/files/${deleteTarget.file.id}${force}`, { method: 'DELETE' })
    if (!j?.ok) flash(j?.error || '删除失败')
    setDeleteTarget(null)
    refresh()
  }

  // 文件夹增删改移已上移到 useFileManager + FileManagerNav(侧栏二级菜单)

  // ---- 分享 ----

  const shareUrl = (tokenStr: string, name: string) => `${location.origin}/api/share/${tokenStr}/${encodeURIComponent(name)}`

  const copyShareLink = async (f: FmFile) => {
    if (!f.share_token) return
    try {
      await navigator.clipboard.writeText(shareUrl(f.share_token, f.name))
      flash('分享链接已复制')
    } catch {
      flash('复制失败')
    }
  }

  const submitShare = async () => {
    if (!shareDialog || shareBusy) return
    setShareBusy(true)
    try {
      const j = await api(`/api/fm/files/${shareDialog.id}/share`, { method: 'POST', body: JSON.stringify({ expires_in: sharePreset }) })
      if (!j?.ok) {
        flash(j?.error || '分享失败')
        return
      }
      const updated = { ...shareDialog, share_token: j.data.token as string, share_expires_at: j.data.share_expires_at as string | null }
      setShareDialog(updated)
      await copyShareLink(updated)
      refresh()
    } finally {
      setShareBusy(false)
    }
  }

  const cancelShare = async () => {
    if (!shareDialog) return
    const j = await api(`/api/fm/files/${shareDialog.id}/share`, { method: 'DELETE' })
    if (!j?.ok) flash(j?.error || '取消失败')
    else {
      setShareDialog({ ...shareDialog, share_token: null, share_expires_at: null })
      flash('已取消分享,链接立即失效')
    }
    refresh()
  }

  const runScan = async () => {
    setScanBusy(true)
    try {
      const j = await api('/api/fm/scan', { method: 'POST' })
      if (j?.ok) flash(`扫描完成:新登记 ${j.data.registered} 个文件,重建 ${j.data.articles_indexed} 篇笔记的引用索引`)
      else flash(j?.error || '扫描失败')
    } finally {
      setScanBusy(false)
      refresh()
    }
  }

  const handleUpload = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    const folderId = view.kind === 'folder' ? view.id : null
    const items = Array.from(list).map((file) => ({ uid: ++uploadUid, file }))
    setUploadingItems(items.map(({ uid, file }) => ({ uid, name: file.name, size: file.size })))
    let fail = 0
    for (const { uid, file } of items) {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
        }
        if (folderId) headers['x-folder-id'] = String(folderId)
        const res = await fetch('/api/files', { method: 'POST', headers, body: file })
        const j = await res.json() as any
        if (!j?.ok) fail++
      } catch {
        fail++
      }
      setUploadingItems((prev) => prev.filter((p) => p.uid !== uid))
    }
    if (fail) flash(`${fail} 个文件上传失败(单文件限 10MB)`)
    refresh()
  }

  // ---- 渲染 ----

  /**
   * 菜单条目。每一项都调**已有的**处理函数,不新开代码路径:
   * 单选走和悬浮按钮完全一样的单文件弹窗(移动/删除都带那份更详细的引用提示),
   * 多选与「复制到…」走 POST /api/fm/files/batch,与底部状态栏同一条路径。
   */
  const buildMenuItems = (f: FmFile | null): MenuItem[] => {
    const items: MenuItem[] = []
    if (!f) {
      items.push({ key: 'upload', icon: '⬆', label: '上传文件', onClick: () => fileInputRef.current?.click() })
      if (files && files.length > 0) {
        items.push({ key: 'all', icon: '☑', label: '全选', onClick: () => { setSel(new Set(files.map((x) => x.id))); setAnchor(null) } })
      }
      items.push({ key: 'refresh', icon: '↻', label: '刷新', onClick: refresh })
      return items
    }
    if (sel.size > 1) {
      items.push({ key: 'move', icon: '📁', label: '移动到…', onClick: () => setBatchMove('move') })
      items.push({ key: 'copy', icon: '📑', label: '复制到…', onClick: () => setBatchMove('copy') })
      items.push({ key: 'link', icon: '📋', label: '复制链接', onClick: copySelectedLinks })
      items.push({ key: 's1', sep: true })
      items.push({ key: 'del', icon: '🗑', label: `删除这 ${sel.size} 个`, danger: true, onClick: () => runBatch('delete') })
      return items
    }
    items.push({ key: 'open', icon: '👁', label: '打开', onClick: () => openPreview(f) })
    items.push({ key: 'download', icon: '⬇', label: '下载', onClick: () => downloadFile(f) })
    items.push({ key: 's1', sep: true })
    items.push({ key: 'link', icon: '📋', label: '复制链接', onClick: () => copyLink(f) })
    // 私密文件夹里的文件禁止分享(服务端也会拒),这里干脆不给入口
    if (!f.is_private_file) {
      items.push({ key: 'share', icon: '🔗', label: '分享…', onClick: () => { setShareDialog(f); setSharePreset(604800) } })
    }
    items.push({ key: 's2', sep: true })
    items.push({ key: 'rename', icon: '✏', label: '重命名', onClick: () => { setRenameTarget(f); setRenameVal(f.name) } })
    items.push({ key: 'move', icon: '📁', label: '移动到…', onClick: () => setMoveTarget(f) })
    items.push({ key: 'copyto', icon: '📑', label: '复制到…', onClick: () => setBatchMove('copy') })
    items.push({ key: 'refs', icon: '🔎', label: f.ref_count > 0 ? `引用:${f.ref_count} 篇笔记` : '引用:无', onClick: async () => setRefsDialog({ file: f, refs: await fetchRefs(f) }) })
    items.push({ key: 's3', sep: true })
    items.push({ key: 'del', icon: '🗑', label: '删除', danger: true, onClick: async () => setDeleteTarget({ file: f, refs: await fetchRefs(f) }) })
    return items
  }

  const folderTree = buildFolderTree(overview?.folders || [])
  // 私密子树(「我的私密文件夹」及其后代):锁图标、禁分享、移入撤销分享的判定都用它
  const privateIds = collectPrivateIds(overview?.folders || [])

  // 标题按 id 从 overview 现取名字(改名后立即跟上;名字不再存进 view)
  const viewTitle =
    view.kind === 'all' ? '全部文件'
    : view.kind === 'unref' ? '未引用'
    : view.kind === 'notebook' ? `笔记附件 · ${overview?.notebooks.find((n) => n.id === view.id)?.name ?? '…'}`
    : `文件夹 · ${overview?.folders.find((f) => f.id === view.id)?.name ?? '…'}`

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
        {/* 顶栏 */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-100 shrink-0">
          <h2 className="text-sm font-semibold text-gray-900">文件管理</h2>
          {overview && (
            <span className="text-xs text-gray-400">
              {overview.stats.count} 个文件 · {fmtSize(overview.stats.size)} / {fmtSize(R2_FREE)}
            </span>
          )}
          {notice && <span className="text-xs text-emerald-600 truncate">{notice}</span>}
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={runScan}
              disabled={scanBusy}
              title="登记 P8.1 之前上传的旧附件,并重建全部引用索引"
              className="px-2.5 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {scanBusy ? '扫描中…' : '扫描登记'}
            </button>
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadingItems.length > 0}
              className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors disabled:opacity-60 flex items-center gap-1.5"
            >
              {uploadingItems.length > 0 ? (
                <>
                  <span className="w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  上传中({uploadingItems.length})
                </>
              ) : '上传文件'}
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { handleUpload(e.target.files); e.target.value = '' }} />
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                title="文件管理设置(列表复选框等)"
                className="p-1.5 rounded-lg text-gray-400 hover:text-emerald-600 hover:bg-gray-100 transition-colors shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.3 4.3a1 1 0 011-.8h1.4a1 1 0 011 .8l.2 1.2a6.6 6.6 0 011.6.9l1.1-.4a1 1 0 011.2.4l.7 1.2a1 1 0 01-.2 1.3l-.9.8a6.7 6.7 0 010 1.8l.9.8a1 1 0 01.2 1.3l-.7 1.2a1 1 0 01-1.2.4l-1.1-.4a6.6 6.6 0 01-1.6.9l-.2 1.2a1 1 0 01-1 .8h-1.4a1 1 0 01-1-.8l-.2-1.2a6.6 6.6 0 01-1.6-.9l-1.1.4a1 1 0 01-1.2-.4l-.7-1.2a1 1 0 01.2-1.3l.9-.8a6.7 6.7 0 010-1.8l-.9-.8a1 1 0 01-.2-1.3l.7-1.2a1 1 0 011.2-.4l1.1.4a6.6 6.6 0 011.6-.9l.2-1.2z" />
                  <circle cx="12" cy="12" r="2.5" />
                </svg>
              </button>
            )}
            <button onClick={onClose} className="text-xs text-gray-400 hover:text-emerald-600 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors shrink-0" title="返回笔记工作区">
              返回笔记
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左栏已上移为侧栏二级菜单(P11.6,见 FileManagerNav.tsx) */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-50 shrink-0 flex-wrap">
              {withCheckbox && files && files.length > 0 && (
                <input
                  type="checkbox"
                  checked={allChecked}
                  onChange={toggleAll}
                  title={allChecked ? '取消全选' : '全选本页'}
                  className="accent-emerald-500 cursor-pointer"
                />
              )}
              <span className="text-sm font-medium text-gray-800">{viewTitle}</span>
              {files && <span className="text-xs text-gray-400">{files.length} 项</span>}
              <div className="flex items-center gap-1 ml-auto">
                {(['all', 'image', 'doc', 'other'] as const).map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setCategory(cat)}
                    className={`px-2 py-1 text-xs rounded-md transition-colors ${
                      category === cat ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {cat === 'all' ? '全部' : CATE_LABEL[cat]}
                  </button>
                ))}
              </div>
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索文件名…"
                className="w-44 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              />
            </div>

            {/* 批量操作已下移到底部状态栏(P13.7):选择状态只在一个地方显示 */}
            {batchMsg && (
              <div className="px-4 py-1.5 text-[11px] text-emerald-700 bg-emerald-50/60 border-b border-emerald-100 shrink-0">{batchMsg}</div>
            )}

            {/* 点列表空白处清空选择(与资源管理器一致);行自己会 stopPropagation 之外的冒泡到这里。
                滚动时收起右键菜单——菜单是按视口坐标定位的,不跟着列表走 */}
            <div
              className="flex-1 overflow-y-auto"
              onClick={(e) => { if (e.target === e.currentTarget && sel.size > 0) { setSel(new Set()); setAnchor(null) } }}
              onContextMenu={onEmptyContextMenu}
              onScroll={() => { if (menu) setMenu(null) }}
            >
              {files === null ? (
                <div className="py-20 flex justify-center">
                  <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : files.length === 0 && uploadingItems.length === 0 ? (
                <div className="py-20 text-center text-gray-400 text-sm">
                  <p className="text-3xl mb-2">🗂</p>
                  <p>{view.kind === 'unref' ? '没有未引用的文件,很干净' : '这里还没有文件'}</p>
                  {view.kind === 'all' && (
                    <p className="text-xs mt-1 text-gray-300">看不到早期上传的附件?点右上角「扫描登记」</p>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {/* 上传占位行:完成一个消掉一个,全部完成后由 refresh 换成真实记录 */}
                  {uploadingItems.map((u) => (
                    <div key={`up-${u.uid}`} className="px-4 py-2 flex items-center gap-3 animate-pulse">
                      <div className="w-10 h-10 rounded-md bg-emerald-50 border border-emerald-100 flex items-center justify-center shrink-0">
                        <span className="w-4 h-4 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-sm text-gray-500 truncate block">{u.name}</span>
                        <p className="text-[11px] text-gray-400 mt-0.5">{fmtSize(u.size)} · 上传中…</p>
                      </div>
                    </div>
                  ))}
                  {files.map((f) => (
                    <div
                      key={f.id}
                      draggable
                      onDragStart={(e) => onRowDragStart(f, e)}
                      onDragEnd={onRowDragEnd}
                      onClick={(e) => clickRow(f, e)}
                      onDoubleClick={() => openPreview(f)}
                      onContextMenu={(e) => onRowContextMenu(f, e)}
                      className={`px-4 py-2 flex items-center gap-3 group select-none cursor-default ${
                        sel.has(f.id) ? 'bg-emerald-100/70' : 'hover:bg-gray-50/70'
                      }`}
                    >
                      {withCheckbox && (
                        <input
                          type="checkbox"
                          checked={sel.has(f.id)}
                          onChange={() => toggleOne(f)}
                          onClick={(e) => e.stopPropagation()}
                          title="选中"
                          className="accent-emerald-500 shrink-0 cursor-pointer"
                        />
                      )}
                      {f.thumb ? (
                        <img
                          src={f.thumb}
                          alt=""
                          loading="lazy"
                          className="w-10 h-10 rounded-md object-cover border border-gray-100 shrink-0 bg-gray-50"
                          onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-md bg-gray-50 border border-gray-100 flex items-center justify-center text-lg shrink-0">
                          {f.category === 'doc' ? '📄' : '📦'}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="text-sm text-gray-800 truncate block" title={`${f.name}(双击打开)`}>{f.name}</span>
                        <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                          <span>{fmtSize(f.size)}</span>
                          <span>{CATE_LABEL[f.category] || f.category}</span>
                          <button
                            onClick={async (e) => { e.stopPropagation(); setRefsDialog({ file: f, refs: await fetchRefs(f) }) }}
                            className={`hover:underline ${f.ref_count > 0 ? 'text-gray-500' : 'text-gray-300'}`}
                            title="查看引用这个文件的笔记"
                          >
                            {f.ref_count > 0 ? `${f.ref_count} 篇笔记引用` : '无引用'}
                          </button>
                        </p>
                      </div>
                      {f.is_private_file ? (
                        <span
                          className="text-[11px] px-1.5 py-0.5 rounded shrink-0 bg-amber-50 text-amber-700"
                          title="在私密文件夹中:禁止公开访问与分享,笔记公开时该附件对访客不可见"
                        >
                          🔒 私密
                        </span>
                      ) : (
                        <span
                          className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${
                            f.pub_count > 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'
                          }`}
                          title={f.pub_count > 0 ? '被公开笔记引用,任何人可访问' : '仅登录后可访问'}
                        >
                          {f.pub_count > 0 ? '公开可访问' : '仅自己'}
                        </span>
                      )}
                      {f.share_token && (
                        <span
                          className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 cursor-pointer ${
                            fmtRemaining(f.share_expires_at) === '已过期' ? 'bg-gray-100 text-gray-400' : 'bg-sky-50 text-sky-600'
                          }`}
                          title={fmtRemaining(f.share_expires_at) === '已过期' ? '分享已过期,点击重新生成' : '已分享,点击查看/复制链接'}
                          onClick={(e) => { e.stopPropagation(); setShareDialog(f); setSharePreset(604800) }}
                        >
                          🔗 {fmtRemaining(f.share_expires_at)}
                        </span>
                      )}
                      {/* 行内动作:一律 stopPropagation,点它们不该改变选择 */}
                      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 text-gray-400" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => copyLink(f)} title="复制链接" className="p-1.5 rounded-md hover:bg-gray-200 text-xs">📋</button>
                        {!f.is_private_file && (
                          <button
                            onClick={() => { setShareDialog(f); setSharePreset(604800) }}
                            title="公开分享(可设有效期)"
                            className="p-1.5 rounded-md hover:bg-gray-200 text-xs"
                          >
                            🔗
                          </button>
                        )}
                        <button onClick={() => openPreview(f)} title="打开预览(或双击整行)" className="p-1.5 rounded-md hover:bg-gray-200 text-xs">👁</button>
                        <button onClick={() => { setRenameTarget(f); setRenameVal(f.name) }} title="重命名" className="p-1.5 rounded-md hover:bg-gray-200 text-xs">✏️</button>
                        <button onClick={() => setMoveTarget(f)} title="移动到文件夹" className="p-1.5 rounded-md hover:bg-gray-200 text-xs">📁</button>
                        <button
                          onClick={async () => setDeleteTarget({ file: f, refs: await fetchRefs(f) })}
                          title="删除"
                          className="p-1.5 rounded-md hover:bg-red-50 text-xs"
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 底部状态栏(P13.7):没选中显示当前视图合计,选中后显示选中合计 + 批量操作。
                取代了原来顶部那条批量条——选择状态在两个地方显示迟早会对不上 */}
            <div className="flex items-center gap-2 px-4 py-2 border-t border-gray-100 bg-gray-50/80 shrink-0 flex-wrap text-xs">
              {sel.size > 0 ? (
                <>
                  <span className="text-emerald-800 font-medium">
                    已选 {summary.count} 个 · 共 {fmtSize(summary.size)}
                  </span>
                  <button onClick={() => { setSel(new Set()); setAnchor(null) }} className="text-gray-500 hover:text-gray-700">取消选择</button>
                  <span className="w-px h-4 bg-gray-200" />
                  <button
                    onClick={() => setBatchMove('move')}
                    disabled={batchBusy}
                    className="px-2.5 py-1 rounded-lg bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  >
                    移动到…
                  </button>
                  <button
                    onClick={() => setBatchMove('copy')}
                    disabled={batchBusy}
                    className="px-2.5 py-1 rounded-lg bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  >
                    复制到…
                  </button>
                  <button
                    onClick={copySelectedLinks}
                    disabled={batchBusy}
                    className="px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-100 disabled:opacity-50"
                  >
                    复制链接
                  </button>
                  <button
                    onClick={() => runBatch('delete')}
                    disabled={batchBusy}
                    className="px-2.5 py-1 rounded-lg bg-white border border-red-200 text-red-600 hover:bg-red-50 disabled:opacity-50"
                  >
                    删除
                  </button>
                  {batchBusy && <span className="w-3.5 h-3.5 border-2 border-emerald-400 border-t-transparent rounded-full animate-spin" />}
                  <span className="text-[11px] text-gray-400 ml-auto">也可以直接把选中的文件拖到左侧目录上</span>
                </>
              ) : (
                <>
                  <span className="text-gray-500">
                    {files ? `${files.length} 个文件 · 共 ${fmtSize(files.reduce((s, f) => s + (Number(f.size) || 0), 0))}` : '加载中…'}
                  </span>
                  <span className="text-[11px] text-gray-400 ml-auto">
                    {withCheckbox ? '勾选多个文件后可批量操作 · 右键打开菜单' : '单击选中 · Ctrl 点选 · Shift 连选 · Ctrl+A 全选 · 双击打开 · 右键菜单'}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

      {/* 右键菜单(P13.8)。z-85:压住列表,同时低于它自己弹出的那些对话框之上的遮罩没有冲突
          (点条目会先 setMenu(null) 再开对话框,两者不会同屏) */}
      {menu && (() => {
        const items = buildMenuItems(menu.file)
        const many = !!menu.file && sel.size > 1
        const h = MENU_PAD * 2 + (many ? MENU_HEAD_H : 0) +
          items.reduce((s, it) => s + ('sep' in it ? MENU_SEP_H : MENU_ITEM_H), 0)
        const pos = menuPosition(menu.x, menu.y, MENU_W, h, window.innerWidth, window.innerHeight)
        return (
          <>
            {/* 透明遮罩:接住「点别处关闭」的那一次点击,顺便挡住它落到某一行上改变选择。
                关在 click 而不是 mousedown——遮罩要一直活到这次点击走完,否则 mouseup 时
                它已经不在了,click 会改派到底下的元素身上。代价是在别处右键要按两次
                (第一次关菜单),换来的是行为确定,不依赖 React 什么时候把卸载刷出去 */}
            <div
              className="fixed inset-0 z-[84]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setMenu(null)}
              onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
            />
            <div
              style={{ left: pos.x, top: pos.y, width: MENU_W }}
              className="fixed z-[85] py-1 rounded-xl bg-white border border-gray-100 shadow-2xl"
              onContextMenu={(e) => e.preventDefault()}
            >
              {many && (
                <div className="px-3 pb-1 mb-1 text-[11px] text-gray-400 border-b border-gray-50 truncate">
                  已选 {summary.count} 个 · 共 {fmtSize(summary.size)}
                </div>
              )}
              {items.map((it) =>
                'sep' in it ? (
                  <div key={it.key} className="my-1 h-px bg-gray-100" />
                ) : (
                  <button
                    key={it.key}
                    onClick={() => { setMenu(null); it.onClick() }}
                    className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 transition-colors ${
                      it.danger ? 'text-red-600 hover:bg-red-50' : 'text-gray-700 hover:bg-emerald-50'
                    }`}
                  >
                    <span className="w-4 shrink-0 text-xs text-center">{it.icon}</span>
                    <span className="truncate">{it.label}</span>
                  </button>
                )
              )}
            </div>
          </>
        )
      })()}

      {/* 图片预览 */}
      {preview?.type === 'image' && (
        <div className="fixed inset-0 z-[80] bg-black/80 flex items-center justify-center p-6 cursor-zoom-out" onClick={() => setPreview(null)}>
          <img src={preview.url} alt={preview.name} className="max-w-full max-h-full rounded-lg shadow-2xl" onClick={(e) => e.stopPropagation()} />
        </div>
      )}

      {/* 文本预览 */}
      {preview?.type === 'text' && (
        <div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-6" onClick={() => setPreview(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[760px] max-w-[92vw] max-h-[85vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-4 py-2.5 border-b border-gray-100 flex items-center">
              <span className="text-sm font-medium text-gray-800 truncate">{preview.name}</span>
              <button onClick={() => setPreview(null)} className="ml-auto p-1 rounded hover:bg-gray-100 text-gray-400">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 text-xs leading-relaxed text-gray-700 whitespace-pre-wrap break-all">{preview.text}</pre>
          </div>
        </div>
      )}

      {/* xmind 预览(复用查看器,可编辑回存) */}
      {preview?.type === 'xmind' && (
        <Suspense fallback={<div className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center text-white text-sm">加载查看器…</div>}>
          <XmindViewer url={preview.url} name={preview.name} token={token} onClose={() => setPreview(null)} onSaved={refresh} />
        </Suspense>
      )}

      {/* 重命名 */}
      {renameTarget && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setRenameTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">重命名</h3>
            <p className="text-[11px] text-gray-400 mb-2">仅改显示名,链接与笔记中的引用不受影响。</p>
            <input
              autoFocus
              value={renameVal}
              onChange={(e) => setRenameVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setRenameTarget(null) }}
              className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRenameTarget(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">取消</button>
              <button onClick={submitRename} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 移动到文件夹 */}
      {moveTarget && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setMoveTarget(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">移动「{moveTarget.name}」</h3>
            <p className="text-[11px] text-gray-400 mb-2">
              目录是虚拟结构,移动不影响链接。归入目录的文件不会随笔记删除被清理。
              移入 🔒 私密文件夹后禁止公开访问,已有分享会被取消。
            </p>
            <div className="max-h-60 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
              <button onClick={() => submitMove(null)} className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50">
                (移出所有文件夹)
              </button>
              {(function flat(nodes: FolderNode[], depth: number): ReactNode[] {
                return nodes.flatMap((n) => [
                  <button
                    key={n.id}
                    onClick={() => submitMove(n.id)}
                    disabled={moveTarget.folder_id === n.id}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50 disabled:opacity-40"
                    style={{ paddingLeft: 12 + depth * 16 }}
                  >
                    {privateIds.has(n.id) ? '🔒' : '📁'} {n.name}
                  </button>,
                  ...flat(n.children, depth + 1),
                ])
              })(folderTree, 0)}
              {folderTree.length === 0 && <p className="px-3 py-3 text-xs text-gray-400">还没有文件夹,先在侧栏「我的文件夹」新建一个</p>}
            </div>
          </div>
        </div>
      )}

      {/* 批量移动 / 复制到文件夹(P13.3):与单个「移动」同一份目录树,只是作用在选中集上 */}
      {batchMove && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setBatchMove(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">
              {batchMove === 'move' ? '移动' : '复制'} {sel.size} 个文件到
            </h3>
            <p className="text-[11px] text-gray-400 mb-2">
              {batchMove === 'move'
                ? '目录是虚拟结构,移动不影响链接。移入 🔒 私密文件夹后禁止公开访问,已有分享会被取消。'
                : '复制会真的多存一份到 R2(占用存储),副本是新链接、不继承分享。一次最多 20 个、单个不超过 10MB,超出的会跳过并列出来。'}
            </p>
            <div className="max-h-60 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
              <button
                onClick={() => runBatch(batchMove, { folder_id: null })}
                className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
              >
                (不归入任何文件夹)
              </button>
              {(function flat(nodes: FolderNode[], depth: number): ReactNode[] {
                return nodes.flatMap((n) => [
                  <button
                    key={n.id}
                    onClick={() => runBatch(batchMove, { folder_id: n.id })}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50"
                    style={{ paddingLeft: 12 + depth * 16 }}
                  >
                    {privateIds.has(n.id) ? '🔒' : '📁'} {n.name}
                  </button>,
                  ...flat(n.children, depth + 1),
                ])
              })(folderTree, 0)}
              {folderTree.length === 0 && <p className="px-3 py-3 text-xs text-gray-400">还没有文件夹,先在侧栏「我的文件夹」新建一个</p>}
            </div>
          </div>
        </div>
      )}

      {/* 批量删除里仍被笔记引用的那些:服务端先回名单,确认后才 force 删 */}
      {batchDel && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setBatchDel(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-96 max-w-[92vw] p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">有 {batchDel.length} 个文件仍被笔记引用</h3>
            <p className="text-[11px] text-gray-400 mb-2">删除后这些笔记里的链接会失效(图片显示为裂图),且无法恢复。</p>
            <ul className="max-h-48 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50 mb-3">
              {batchDel.map((x) => (
                <li key={x.id} className="px-3 py-1.5 text-xs text-gray-700 flex items-center gap-2">
                  <span className="truncate flex-1">{x.name}</span>
                  <span className="text-gray-400 shrink-0">{x.refs} 篇</span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button onClick={() => setBatchDel(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">取消</button>
              <button
                onClick={() => runBatch('delete', { force: true })}
                disabled={batchBusy}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50"
              >
                仍要删除全部 {sel.size} 个
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 引用清单 */}
      {refsDialog && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setRefsDialog(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-96 max-w-[92vw] p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-2 truncate">「{refsDialog.file.name}」的引用</h3>
            {refsDialog.refs.length === 0 ? (
              <p className="text-xs text-gray-400">没有笔记引用这个文件。</p>
            ) : (
              <div className="max-h-72 overflow-y-auto divide-y divide-gray-50 border border-gray-100 rounded-lg">
                {refsDialog.refs.map((r) => (
                  <div key={r.id} className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => window.open(`/?article=${r.id}`, '_blank', 'noopener')}
                        className="truncate flex-1 text-left text-sm text-gray-700 hover:text-emerald-600 hover:underline"
                        title="在新窗口打开这篇笔记"
                      >
                        {r.title}
                      </button>
                      {r.is_private ? (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0">私有</span>
                      ) : r.is_public ? (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 shrink-0">公开</span>
                      ) : (
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400 shrink-0">未公开</span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                      <span>更新于 {fmtDateTime(r.updated_at)}</span>
                      {r.notebook && <span className="truncate">{r.notebook}</span>}
                    </p>
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end mt-3">
              <button onClick={() => setRefsDialog(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 分享(单分享:重新生成即替换,取消立即失效;私密文件夹内无此入口) */}
      {shareDialog && (() => {
        const active = !!shareDialog.share_token && fmtRemaining(shareDialog.share_expires_at) !== '已过期'
        return (
          <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setShareDialog(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-[400px] max-w-[92vw] p-4" onMouseDown={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-gray-900 mb-1 truncate">分享「{shareDialog.name}」</h3>
              <p className="text-[11px] text-gray-400 mb-3">
                任何拿到链接的人在有效期内都可访问该文件。一个文件同时只有一个分享链接,重新生成后旧链接立即失效。
              </p>
              {shareDialog.share_token && (
                <div className="mb-3 border border-sky-100 bg-sky-50/60 rounded-lg p-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={shareUrl(shareDialog.share_token, shareDialog.name)}
                      onFocus={(e) => e.target.select()}
                      className="flex-1 min-w-0 text-[11px] text-gray-600 bg-white border border-gray-200 rounded px-2 py-1 focus:outline-none"
                    />
                    <button
                      onClick={() => copyShareLink(shareDialog)}
                      className="px-2 py-1 text-[11px] rounded bg-sky-500 text-white hover:bg-sky-600 shrink-0"
                    >
                      复制
                    </button>
                  </div>
                  <p className="text-[11px] mt-1.5 flex items-center justify-between">
                    <span className={active ? 'text-sky-600' : 'text-amber-600'}>
                      {active ? `有效期:${fmtRemaining(shareDialog.share_expires_at)}` : '已过期,可选择有效期重新生成'}
                    </span>
                    <button onClick={cancelShare} className="text-red-400 hover:text-red-600 hover:underline">取消分享</button>
                  </p>
                </div>
              )}
              <p className="text-xs font-medium text-gray-600 mb-1.5">有效期</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {EXPIRY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setSharePreset(p.seconds)}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                      sharePreset === p.seconds
                        ? 'border-emerald-400 bg-emerald-50 text-emerald-700 font-medium'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setShareDialog(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">关闭</button>
                <button
                  onClick={submitShare}
                  disabled={shareBusy}
                  className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  {shareBusy ? '生成中…' : shareDialog.share_token ? '重新生成链接' : '生成分享链接'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 删除文件确认 */}
      {deleteTarget && (
        <ConfirmDialog
          title={`删除「${deleteTarget.file.name}」？`}
          message={
            deleteTarget.refs.length > 0
              ? `该文件仍被 ${deleteTarget.refs.length} 篇笔记引用(${deleteTarget.refs.slice(0, 3).map((r) => `《${r.title}》`).join('、')}${deleteTarget.refs.length > 3 ? ' 等' : ''}),删除后这些笔记中的链接将失效,且不可恢复。`
              : '文件将从存储中删除,不可恢复。'
          }
          confirmText={deleteTarget.refs.length > 0 ? '仍要删除' : '删除'}
          onConfirm={submitDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  )
}
