import { useCallback, useEffect, useState } from 'react'

// P9.2 笔记链接选择器:搜索标题,选中插入 [标题](/?article=<id>) 标准 MD 链接
// (深链在应用内/新窗口都能打开;反向链接按此格式 instr 反查)。源码/富文本两模式共用。

export interface NoteLinkItem {
  id: number
  title: string
  updated_at: string
  notebook: string | null
}

interface Props {
  token: string
  /** 当前文章 id(从结果中排除自己) */
  excludeId?: number
  onClose: () => void
  onPick: (a: NoteLinkItem) => void
}

export default function NoteLinkDialog({ token, excludeId, onClose, onPick }: Props) {
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [items, setItems] = useState<NoteLinkItem[] | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/articles/titles?q=${encodeURIComponent(qDebounced)}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j: any = await res.json()
      setItems(j?.ok ? (j.data as NoteLinkItem[]).filter((a) => a.id !== excludeId) : [])
    } catch {
      setItems([])
    }
  }, [token, qDebounced, excludeId])

  useEffect(() => { setItems(null); load() }, [load])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const fmtDate = (s: string) => {
    const d = new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z')
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[94vw] max-h-[70vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 shrink-0">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">插入笔记链接</h3>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索笔记标题…"
            className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
          />
        </div>
        <div className="flex-1 overflow-y-auto min-h-[160px]">
          {items === null ? (
            <div className="py-12 flex justify-center">
              <div className="w-5 h-5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-12 text-center text-sm text-gray-400">没有匹配的笔记</p>
          ) : (
            <div className="divide-y divide-gray-50">
              {items.map((a) => (
                <button
                  key={a.id}
                  onClick={() => { onPick(a); onClose() }}
                  className="w-full text-left px-4 py-2 hover:bg-emerald-50/60 transition-colors"
                >
                  <span className="text-sm text-gray-800 truncate block">{a.title}</span>
                  <span className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
                    {a.notebook && <span className="truncate">{a.notebook}</span>}
                    <span className="shrink-0">{fmtDate(a.updated_at)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-50 shrink-0">
          插入标准链接 [标题](/?article=id):预览中点击应用内打开,被链接的笔记会显示反向链接。
        </p>
      </div>
    </div>
  )
}
