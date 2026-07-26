import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import type { Notebook } from '../types'

// 博客管理(P11.1):全屏模块,集中管理所有已公开(博客)文章——搜索/按笔记本过滤/预览/打开编辑/取消公开。
// (P11.2 将在此加「评论管理」子视图。)照搬 FileManager 的全屏叠层骨架。

interface PublishedArticle {
  id: number
  notebook_id: number
  notebook: string | null
  title: string
  summary: string
  published_at: string | null
  updated_at: string
  views: number
}

interface Props {
  token: string
  notebooks: Notebook[]
  onClose: () => void
  /** 打开进主应用编辑(复用 Layout 的跨笔记切换通道) */
  onOpenArticle: (id: number) => void
}

// published_at 存为 UTC 的 "YYYY-MM-DD HH:MM:SS"(无时区),补 Z 归一后取日期
function fmtDate(s: string | null): string {
  if (!s) return '—'
  const iso = /[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return s
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function BlogManager({ token, notebooks, onClose, onOpenArticle }: Props) {
  const api = useApi(token)
  const [q, setQ] = useState('')
  const [nbFilter, setNbFilter] = useState(0)
  const [items, setItems] = useState<PublishedArticle[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const load = useCallback(async () => {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (nbFilter) params.set('notebook_id', String(nbFilter))
    const res = await api.get<PublishedArticle[]>(`/articles/published?${params.toString()}`)
    setItems(res.ok && res.data ? res.data : [])
  }, [api, q, nbFilter])

  // 过滤/搜索变化 300ms 去抖刷新
  useEffect(() => {
    const t = setTimeout(load, 300)
    return () => clearTimeout(t)
  }, [load])

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const unpublish = async (id: number) => {
    setBusyId(id)
    const res = await api.put(`/articles/${id}`, { is_public: 0 })
    if (res.ok) setItems((cur) => (cur || []).filter((a) => a.id !== id))
    setBusyId(null)
  }

  const openInApp = (id: number) => { onOpenArticle(id); onClose() }

  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-3 sm:p-6" onMouseDown={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full h-full max-w-[1000px] flex flex-col overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        {/* 顶栏 */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="w-7 h-7 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0">📢</span>
            <span className="font-semibold text-gray-900">博客管理</span>
            {items && <span className="text-xs text-gray-400 shrink-0">{items.length} 篇已公开</span>}
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 shrink-0" title="关闭">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 过滤条 */}
        <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标题…"
            className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
          />
          <select
            value={nbFilter}
            onChange={(e) => setNbFilter(Number(e.target.value))}
            className="text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 outline-none focus:border-emerald-400 max-w-[180px]"
          >
            <option value={0}>全部笔记本</option>
            {notebooks.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
        </div>

        {/* 列表 */}
        <div className="flex-1 overflow-y-auto p-3">
          {items === null ? (
            <div className="py-20 flex justify-center">
              <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="py-20 text-center text-sm text-gray-400">
              {q || nbFilter ? '没有匹配的已公开文章' : '还没有公开任何文章。在编辑器里点「公开」即可发布到博客。'}
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-gray-50 border border-transparent hover:border-gray-100">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-800 truncate">{a.title || '无标题'}</div>
                    <div className="text-[11px] text-gray-400 flex items-center gap-2 mt-0.5">
                      <span className="truncate max-w-[140px]">{a.notebook || '—'}</span>
                      <span>· {fmtDate(a.published_at)}</span>
                      <span>· {a.views} 浏览</span>
                    </div>
                  </div>
                  <a href={`/blog/${a.id}`} target="_blank" rel="noreferrer" className="text-xs text-gray-400 hover:text-emerald-600 shrink-0" title="在新标签预览博客页">预览↗</a>
                  <button onClick={() => openInApp(a.id)} className="text-xs text-emerald-600 hover:underline shrink-0">打开</button>
                  <button
                    onClick={() => unpublish(a.id)}
                    disabled={busyId === a.id}
                    className="text-xs text-gray-400 hover:text-red-500 shrink-0 disabled:opacity-50"
                    title="从博客撤下(设为不公开)"
                  >
                    {busyId === a.id ? '…' : '取消公开'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
