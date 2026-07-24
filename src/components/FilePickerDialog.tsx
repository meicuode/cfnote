import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtSize } from '../lib/fmUtils'

// P8.3 编辑器文件库选择器(见 docs/file-manager.md):双 Tab——
// 「从文件库选择」既有附件(插入现成 URL,不重复占用存储)/「上传新文件」(走调用方现有上传管线,
// 保持 xmind 边车缩略图、blob 占位等行为)。源码/富文本两模式共用,插入方式由调用方决定。

export interface PickedFile {
  id: number
  url: string
  name: string
  size: number
  category: 'image' | 'doc' | 'other'
  content_type: string | null
  thumb: string | null
  ref_count: number
  is_private_file: boolean
}

interface Props {
  token: string
  onClose: () => void
  /** 从文件库选中:调用方插入既有 URL */
  onPick: (f: PickedFile) => void
  /** 上传新文件:走调用方现有上传插入管线 */
  onUpload: (files: File[]) => void
}

const CATE_LABEL: Record<string, string> = { image: '图片', doc: '文档', other: '其他' }

export default function FilePickerDialog({ token, onClose, onPick, onUpload }: Props) {
  const [tab, setTab] = useState<'library' | 'upload'>('library')
  const [category, setCategory] = useState<'all' | 'image' | 'doc' | 'other'>('all')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [files, setFiles] = useState<PickedFile[] | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(async () => {
    const p = new URLSearchParams({ view: 'all' })
    if (category !== 'all') p.set('category', category)
    if (qDebounced) p.set('q', qDebounced)
    try {
      const res = await fetch(`/api/fm/files?${p}`, { headers: { Authorization: `Bearer ${token}` } })
      const j: any = await res.json()
      setFiles(j?.ok ? j.data.files : [])
    } catch {
      setFiles([])
    }
  }, [token, category, qDebounced])

  useEffect(() => { setFiles(null); load() }, [load])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const pick = (f: PickedFile) => {
    onPick(f)
    onClose()
  }

  const uploadFiles = (list: File[] | FileList | null) => {
    const arr = Array.from(list || [])
    if (arr.length === 0) return
    onUpload(arr)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[94vw] h-[520px] max-h-[86vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Tab 头 */}
        <div className="flex items-center px-4 pt-2 border-b border-gray-100 shrink-0">
          {([['library', '从文件库选择'], ['upload', '上传新文件']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${
                tab === k ? 'border-emerald-500 text-emerald-600 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {label}
            </button>
          ))}
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors" title="关闭">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {tab === 'library' ? (
          <>
            <div className="flex items-center gap-2 px-4 py-2.5 shrink-0 flex-wrap">
              <div className="flex items-center gap-1">
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
                autoFocus
                placeholder="搜索文件名…"
                className="flex-1 min-w-[140px] text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
              />
            </div>
            <div className="flex-1 overflow-y-auto border-t border-gray-50">
              {files === null ? (
                <div className="py-16 flex justify-center">
                  <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                </div>
              ) : files.length === 0 ? (
                <div className="py-16 text-center text-gray-400 text-sm">
                  <p className="text-3xl mb-2">🗂</p>
                  <p>{qDebounced || category !== 'all' ? '没有匹配的文件' : '文件库还是空的'}</p>
                  <p className="text-xs mt-1 text-gray-300">早期上传的附件需先在「文件管理」中扫描登记</p>
                </div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {files.map((f) => (
                    <button
                      key={f.id}
                      onClick={() => pick(f)}
                      className="w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-emerald-50/60 transition-colors"
                      title="插入到笔记"
                    >
                      {f.thumb ? (
                        <img
                          src={f.thumb}
                          alt=""
                          loading="lazy"
                          className="w-10 h-10 rounded-md object-cover border border-gray-100 shrink-0 bg-gray-50"
                          onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden' }}
                        />
                      ) : (
                        <span className="w-10 h-10 rounded-md bg-gray-50 border border-gray-100 flex items-center justify-center text-lg shrink-0">
                          {f.category === 'doc' ? '📄' : '📦'}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="text-sm text-gray-800 truncate block">{f.name}</span>
                        <span className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                          <span>{fmtSize(f.size)}</span>
                          <span>{CATE_LABEL[f.category] || f.category}</span>
                          {f.ref_count > 0 && <span>{f.ref_count} 篇引用</span>}
                        </span>
                      </span>
                      {f.is_private_file && (
                        <span
                          className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0"
                          title="私密文件夹中:笔记公开时该附件对访客不可见"
                        >
                          🔒 私密
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <p className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-50 shrink-0">
              选中即插入链接,不重复占用存储;🔒 私密文件可插入,但笔记公开时访客不可见。
            </p>
          </>
        ) : (
          <div className="flex-1 p-4">
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); uploadFiles(e.dataTransfer.files) }}
              className={`h-full rounded-xl border-2 border-dashed flex flex-col items-center justify-center gap-2 cursor-pointer transition-colors ${
                dragOver ? 'border-emerald-400 bg-emerald-50/60' : 'border-gray-200 hover:border-emerald-300 hover:bg-gray-50/60'
              }`}
            >
              <span className="text-3xl">📤</span>
              <p className="text-sm text-gray-600">点击选择文件,或把文件拖到这里</p>
              <p className="text-xs text-gray-400">支持任意格式,单文件 ≤ 10MB,可多选;图片也可直接粘贴进编辑器</p>
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => { uploadFiles(e.target.files); e.target.value = '' }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
