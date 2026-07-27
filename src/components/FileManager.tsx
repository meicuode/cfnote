import { useCallback, useEffect, useRef, useState, lazy, Suspense, type ReactNode } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { buildFolderTree, collectPrivateIds, fmtSize, fmtRemaining, previewKind, EXPIRY_PRESETS, type FolderNode, type FolderRow } from '../lib/fmUtils'

const XmindViewer = lazy(() => import('./XmindViewer'))

// 文件管理页(P8.2,见 docs/file-manager.md):全屏面板,管理应用内全部附件。
// 左栏:全部/未引用/笔记附件(按笔记本,派生只读)/我的文件夹(虚拟目录,移动改名不影响链接);
// 右侧:分类筛选+名称搜索+列表(预览/复制链接/重命名/移动/删除),顶部统计与扫描登记/上传。

interface Props {
  token: string
  onClose: () => void
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

interface FmOverview {
  stats: { count: number; size: number }
  unref_count: number
  notebooks: { id: number; name: string; color: string; file_count: number }[]
  folders: (FolderRow & { created_at: string })[]
}

interface RefItem {
  id: number
  title: string
  is_public: number
  is_private: number
  updated_at: string
  notebook: string | null
}

type View =
  | { kind: 'all' }
  | { kind: 'unref' }
  | { kind: 'notebook'; id: number; name: string }
  | { kind: 'folder'; id: number; name: string }

const CATE_LABEL: Record<string, string> = { image: '图片', doc: '文档', other: '其他' }
const R2_FREE = 10 * 1024 * 1024 * 1024

// 服务端时间统一 UTC(datetime('now') 无时区尾巴),补 Z 再按本地时区展示
const fmtDateTime = (s: string) => {
  const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z')
  return isNaN(d.getTime())
    ? s
    : d.toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
}

let uploadUid = 0

export default function FileManager({ token, onClose }: Props) {
  const [overview, setOverview] = useState<FmOverview | null>(null)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [category, setCategory] = useState<'all' | 'image' | 'doc' | 'other'>('all')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [files, setFiles] = useState<FmFile[] | null>(null)
  const [notice, setNotice] = useState('')
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
  const [folderInput, setFolderInput] = useState<{ parent: number | null; parentName?: string } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderRename, setFolderRename] = useState<FolderRow | null>(null)
  const [folderRenameVal, setFolderRenameVal] = useState('')
  const [folderDelete, setFolderDelete] = useState<FolderRow | null>(null)
  const [folderMove, setFolderMove] = useState<FolderNode | null>(null)
  // 分享对话框:对着一份本地文件快照操作,生成/取消后同步回列表
  const [shareDialog, setShareDialog] = useState<FmFile | null>(null)
  const [sharePreset, setSharePreset] = useState<number | null>(604800)
  const [shareBusy, setShareBusy] = useState(false)

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

  const loadOverview = useCallback(async () => {
    const j = await api('/api/fm/overview').catch(() => null)
    if (j?.ok) setOverview(j.data)
  }, [api])

  const loadFiles = useCallback(async () => {
    const p = new URLSearchParams({ view: view.kind })
    if (view.kind === 'notebook') p.set('notebook', String(view.id))
    if (view.kind === 'folder') p.set('folder', String(view.id))
    if (category !== 'all') p.set('category', category)
    if (qDebounced) p.set('q', qDebounced)
    const j = await api(`/api/fm/files?${p}`).catch(() => null)
    setFiles(j?.ok ? j.data.files : [])
  }, [api, view, category, qDebounced])

  useEffect(() => { loadOverview() }, [loadOverview])
  useEffect(() => { setFiles(null); loadFiles() }, [loadFiles])
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  // 注:P11.5 改为内联模块后不再监听 Esc 关闭整个视图——搜索框里按 Esc 会误关工作区。
  // 各子弹窗(重命名/移动/分享等)自身的 Esc 关闭仍在各自处理。

  const refresh = useCallback(() => { loadOverview(); loadFiles() }, [loadOverview, loadFiles])

  const flash = (msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), 3000)
  }

  // ---- 操作 ----

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
      const a = document.createElement('a')
      a.href = f.url
      a.download = f.name
      a.click()
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

  const submitFolderCreate = async () => {
    if (!folderInput || !folderName.trim()) return
    const j = await api('/api/fm/folders', { method: 'POST', body: JSON.stringify({ name: folderName.trim(), parent_id: folderInput.parent }) })
    if (!j?.ok) flash(j?.error || '创建失败')
    setFolderInput(null)
    setFolderName('')
    loadOverview()
  }

  const submitFolderRename = async () => {
    if (!folderRename || !folderRenameVal.trim()) return
    const j = await api(`/api/fm/folders/${folderRename.id}`, { method: 'PUT', body: JSON.stringify({ name: folderRenameVal.trim() }) })
    if (!j?.ok) flash(j?.error || '重命名失败')
    setFolderRename(null)
    loadOverview()
  }

  const submitFolderDelete = async () => {
    if (!folderDelete) return
    const j = await api(`/api/fm/folders/${folderDelete.id}`, { method: 'DELETE' })
    if (!j?.ok) flash(j?.error || '删除失败')
    else if (view.kind === 'folder' && view.id === folderDelete.id) setView({ kind: 'all' })
    setFolderDelete(null)
    loadOverview()
  }

  const submitFolderMove = async (parentId: number | null) => {
    if (!folderMove) return
    const j = await api(`/api/fm/folders/${folderMove.id}`, { method: 'PUT', body: JSON.stringify({ parent_id: parentId }) })
    if (!j?.ok) flash(j?.error || '移动失败')
    else if (j.data?.revoked_shares > 0) flash(`已移入私密文件夹,取消了 ${j.data.revoked_shares} 个文件的分享`)
    setFolderMove(null)
    refresh()
  }

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

  const folderTree = buildFolderTree(overview?.folders || [])
  // 私密子树(「我的私密文件夹」及其后代):锁图标、禁分享、移入撤销分享的判定都用它
  const privateIds = collectPrivateIds(overview?.folders || [])

  const railItem = (active: boolean, onClick: () => void, content: ReactNode, extra?: ReactNode) => (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm transition-colors group ${
        active ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
      }`}
    >
      {content}
      {extra}
    </button>
  )

  const renderFolder = (node: FolderNode, depth: number): ReactNode => (
    <div key={node.id}>
      <div style={{ paddingLeft: depth * 14 }}>
        {railItem(
          view.kind === 'folder' && view.id === node.id,
          () => setView({ kind: 'folder', id: node.id, name: node.name }),
          <>
            <span className="shrink-0">{privateIds.has(node.id) ? '🔒' : '📁'}</span>
            <span
              className="truncate flex-1"
              title={privateIds.has(node.id) ? '私密文件夹:其中的文件禁止公开访问与分享' : undefined}
            >
              {node.name}
            </span>
          </>,
          <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <span
              role="button"
              title="新建子目录"
              onClick={(e) => { e.stopPropagation(); setFolderInput({ parent: node.id, parentName: node.name }); setFolderName('') }}
              className="p-0.5 rounded hover:bg-gray-200 text-gray-400"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M12 4v16m8-8H4" /></svg>
            </span>
            {/* 系统私密根目录不可改名/移动/删除,只留新建子目录 */}
            {!node.is_private && (
              <>
                <span
                  role="button"
                  title="重命名"
                  onClick={(e) => { e.stopPropagation(); setFolderRename(node); setFolderRenameVal(node.name) }}
                  className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
                >
                  ✏️
                </span>
                <span
                  role="button"
                  title="移动到其他文件夹"
                  onClick={(e) => { e.stopPropagation(); setFolderMove(node) }}
                  className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
                >
                  ⇄
                </span>
                <span
                  role="button"
                  title="删除(须为空)"
                  onClick={(e) => { e.stopPropagation(); setFolderDelete(node) }}
                  className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
                >
                  🗑
                </span>
              </>
            )}
          </span>
        )}
      </div>
      {node.children.map((ch) => renderFolder(ch, depth + 1))}
    </div>
  )

  const viewTitle =
    view.kind === 'all' ? '全部文件'
    : view.kind === 'unref' ? '未引用'
    : view.kind === 'notebook' ? `笔记附件 · ${view.name}`
    : `文件夹 · ${view.name}`

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
            <button onClick={onClose} className="text-xs text-gray-400 hover:text-emerald-600 px-2 py-1 rounded-lg hover:bg-gray-100 transition-colors shrink-0" title="返回笔记工作区">
              返回笔记
            </button>
          </div>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* 左栏 */}
          <div className="w-52 border-r border-gray-100 bg-gray-50/70 overflow-y-auto p-2 shrink-0 hidden sm:block">
            {railItem(view.kind === 'all', () => setView({ kind: 'all' }), <><span className="shrink-0">🗂</span><span className="flex-1">全部文件</span></>)}
            {railItem(
              view.kind === 'unref',
              () => setView({ kind: 'unref' }),
              <><span className="shrink-0">🧹</span><span className="flex-1">未引用</span></>,
              overview && overview.unref_count > 0 ? <span className="text-xs text-gray-400">{overview.unref_count}</span> : undefined
            )}

            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider px-2.5 mt-3 mb-1">笔记附件</p>
            {(overview?.notebooks || []).map((nb) =>
              <div key={nb.id}>
                {railItem(
                  view.kind === 'notebook' && view.id === nb.id,
                  () => setView({ kind: 'notebook', id: nb.id, name: nb.name }),
                  <>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: nb.color }} />
                    <span className="truncate flex-1">{nb.name}</span>
                  </>,
                  <span className="text-xs text-gray-400 shrink-0">{nb.file_count}</span>
                )}
              </div>
            )}
            {overview && overview.notebooks.length === 0 && (
              <p className="text-[11px] text-gray-400 px-2.5 py-1">笔记里还没有附件</p>
            )}

            <div className="flex items-center justify-between px-2.5 mt-3 mb-1">
              <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">我的文件夹</p>
              <button
                onClick={() => { setFolderInput({ parent: null }); setFolderName('') }}
                className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
                title="新建文件夹"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M12 4v16m8-8H4" /></svg>
              </button>
            </div>
            {folderInput && (
              <div className="px-2.5 mb-1.5">
                {folderInput.parentName && <p className="text-[11px] text-gray-400 mb-0.5">在「{folderInput.parentName}」下:</p>}
                <input
                  autoFocus
                  value={folderName}
                  onChange={(e) => setFolderName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitFolderCreate()
                    if (e.key === 'Escape') setFolderInput(null)
                  }}
                  onBlur={() => { if (!folderName.trim()) setFolderInput(null) }}
                  placeholder="文件夹名称"
                  className="w-full text-xs border border-emerald-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                />
              </div>
            )}
            {folderTree.map((n) => renderFolder(n, 0))}
            {overview && folderTree.length === 0 && !folderInput && (
              <p className="text-[11px] text-gray-400 px-2.5 py-1">手工上传的文件可归入文件夹</p>
            )}
          </div>

          {/* 右侧 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-50 shrink-0 flex-wrap">
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

            <div className="flex-1 overflow-y-auto">
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
                    <div key={f.id} className="px-4 py-2 flex items-center gap-3 hover:bg-gray-50/70 group">
                      {f.thumb ? (
                        <img
                          src={f.thumb}
                          alt=""
                          loading="lazy"
                          className="w-10 h-10 rounded-md object-cover border border-gray-100 shrink-0 cursor-zoom-in bg-gray-50"
                          onClick={() => openPreview(f)}
                          onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                        />
                      ) : (
                        <button
                          onClick={() => openPreview(f)}
                          className="w-10 h-10 rounded-md bg-gray-50 border border-gray-100 flex items-center justify-center text-lg shrink-0"
                        >
                          {f.category === 'doc' ? '📄' : '📦'}
                        </button>
                      )}
                      <div className="min-w-0 flex-1">
                        <button onClick={() => openPreview(f)} className="block max-w-full text-left" title={f.name}>
                          <span className="text-sm text-gray-800 truncate block hover:text-emerald-600 transition-colors">{f.name}</span>
                        </button>
                        <p className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                          <span>{fmtSize(f.size)}</span>
                          <span>{CATE_LABEL[f.category] || f.category}</span>
                          <button
                            onClick={async () => setRefsDialog({ file: f, refs: await fetchRefs(f) })}
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
                          onClick={() => { setShareDialog(f); setSharePreset(604800) }}
                        >
                          🔗 {fmtRemaining(f.share_expires_at)}
                        </span>
                      )}
                      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 text-gray-400">
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
          </div>
        </div>

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
              {folderTree.length === 0 && <p className="px-3 py-3 text-xs text-gray-400">还没有文件夹,先在左栏新建一个</p>}
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

      {/* 移动文件夹(排除自身及其子树;移入私密子树会取消其中文件的分享) */}
      {folderMove && (() => {
        const excluded = new Set<number>()
        const walk = (n: FolderNode) => { excluded.add(n.id); n.children.forEach(walk) }
        walk(folderMove)
        return (
          <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setFolderMove(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-gray-900 mb-1">移动文件夹「{folderMove.name}」</h3>
              <p className="text-[11px] text-gray-400 mb-2">
                移动不影响任何文件链接。移入 🔒 私密文件夹后,其中所有文件禁止公开,已有分享会被取消。
              </p>
              <div className="max-h-60 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                <button
                  onClick={() => submitFolderMove(null)}
                  disabled={folderMove.parent_id == null}
                  className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                >
                  (移到根目录)
                </button>
                {(function flat(nodes: FolderNode[], depth: number): ReactNode[] {
                  return nodes.flatMap((n) => {
                    if (excluded.has(n.id)) return []
                    return [
                      <button
                        key={n.id}
                        onClick={() => submitFolderMove(n.id)}
                        disabled={folderMove.parent_id === n.id}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50 disabled:opacity-40"
                        style={{ paddingLeft: 12 + depth * 16 }}
                      >
                        {privateIds.has(n.id) ? '🔒' : '📁'} {n.name}
                      </button>,
                      ...flat(n.children, depth + 1),
                    ]
                  })
                })(folderTree, 0)}
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

      {/* 文件夹重命名 */}
      {folderRename && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setFolderRename(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">重命名文件夹</h3>
            <input
              autoFocus
              value={folderRenameVal}
              onChange={(e) => setFolderRenameVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitFolderRename(); if (e.key === 'Escape') setFolderRename(null) }}
              className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setFolderRename(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">取消</button>
              <button onClick={submitFolderRename} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除文件夹确认(空目录) */}
      {folderDelete && (
        <ConfirmDialog
          title={`删除文件夹「${folderDelete.name}」？`}
          message="仅能删除空文件夹;若其中还有文件或子目录会被拒绝。"
          onConfirm={submitFolderDelete}
          onCancel={() => setFolderDelete(null)}
        />
      )}
    </div>
  )
}
