import { useCallback, useEffect, useRef, useState, lazy, Suspense, type ReactNode } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { buildFolderTree, fmtSize, previewKind, type FolderNode, type FolderRow } from '../lib/fmUtils'

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
  created_at: string
  updated_at: string
  url: string
  thumb: string | null
  ref_count: number
  pub_count: number
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
  notebook: string | null
}

type View =
  | { kind: 'all' }
  | { kind: 'unref' }
  | { kind: 'notebook'; id: number; name: string }
  | { kind: 'folder'; id: number; name: string }

const CATE_LABEL: Record<string, string> = { image: '图片', doc: '文档', other: '其他' }
const R2_FREE = 10 * 1024 * 1024 * 1024

export default function FileManager({ token, onClose }: Props) {
  const [overview, setOverview] = useState<FmOverview | null>(null)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [category, setCategory] = useState<'all' | 'image' | 'doc' | 'other'>('all')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [files, setFiles] = useState<FmFile[] | null>(null)
  const [notice, setNotice] = useState('')
  const [scanBusy, setScanBusy] = useState(false)
  const [uploading, setUploading] = useState(0)

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !preview && !renameTarget && !moveTarget && !refsDialog && !deleteTarget) onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, preview, renameTarget, moveTarget, refsDialog, deleteTarget])

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
    setUploading(list.length)
    let fail = 0
    for (const file of Array.from(list)) {
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
      setUploading((n) => n - 1)
    }
    if (fail) flash(`${fail} 个文件上传失败(单文件限 10MB)`)
    refresh()
  }

  // ---- 渲染 ----

  const folderTree = buildFolderTree(overview?.folders || [])

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
            <span className="shrink-0">📁</span>
            <span className="truncate flex-1">{node.name}</span>
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
              title="删除(须为空)"
              onClick={(e) => { e.stopPropagation(); setFolderDelete(node) }}
              className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
            >
              🗑
            </span>
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
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-3 sm:p-6">
      <div className="bg-white rounded-2xl shadow-2xl w-full h-full max-w-[1200px] flex flex-col overflow-hidden">
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
              className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
            >
              {uploading > 0 ? `上传中(${uploading})` : '上传文件'}
            </button>
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(e) => { handleUpload(e.target.files); e.target.value = '' }} />
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" title="关闭">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
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
              ) : files.length === 0 ? (
                <div className="py-20 text-center text-gray-400 text-sm">
                  <p className="text-3xl mb-2">🗂</p>
                  <p>{view.kind === 'unref' ? '没有未引用的文件,很干净' : '这里还没有文件'}</p>
                  {view.kind === 'all' && (
                    <p className="text-xs mt-1 text-gray-300">看不到早期上传的附件?点右上角「扫描登记」</p>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
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
                      <span
                        className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${
                          f.pub_count > 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-gray-100 text-gray-400'
                        }`}
                        title={f.pub_count > 0 ? '被公开笔记引用,任何人可访问' : '仅登录后可访问'}
                      >
                        {f.pub_count > 0 ? '公开可访问' : '仅自己'}
                      </span>
                      <div className="hidden group-hover:flex items-center gap-0.5 shrink-0 text-gray-400">
                        <button onClick={() => copyLink(f)} title="复制链接" className="p-1.5 rounded-md hover:bg-gray-200 text-xs">📋</button>
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
            <p className="text-[11px] text-gray-400 mb-2">目录是虚拟结构,移动不影响链接。归入目录的文件不会随笔记删除被清理。</p>
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
                    📁 {n.name}
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
              <div className="max-h-64 overflow-y-auto divide-y divide-gray-50 border border-gray-100 rounded-lg">
                {refsDialog.refs.map((r) => (
                  <div key={r.id} className="px-3 py-2 flex items-center gap-2 text-sm">
                    <span className="truncate flex-1 text-gray-700">{r.title}</span>
                    {r.notebook && <span className="text-[11px] text-gray-400 shrink-0">{r.notebook}</span>}
                    {r.is_private ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0">私有</span>
                    ) : r.is_public ? (
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 shrink-0">公开</span>
                    ) : null}
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
