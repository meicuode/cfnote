import { useEffect, useMemo, useState } from 'react'

// 标签浏览器(P10.4):侧栏「全部标签」入口打开,搜索 + 按频次排序的全部标签。
// 点击一个标签即进入该标签虚拟视图并关闭。

interface Props {
  tags: { name: string; count: number }[]
  activeName?: string | null
  onPick: (name: string) => void
  onClose: () => void
}

export default function TagBrowserDialog({ tags, activeName, onPick, onClose }: Props) {
  const [q, setQ] = useState('')

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const sorted = useMemo(
    () => [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh')),
    [tags],
  )
  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    return kw ? sorted.filter((t) => t.name.toLowerCase().includes(kw)) : sorted
  }, [sorted, q])

  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-start justify-center p-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-96 max-w-[92vw] max-h-[70vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">标签 · 共 {tags.length} 个</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>
        <div className="p-3 shrink-0">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索标签…"
            className="w-full text-sm px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-transparent text-gray-800 dark:text-gray-100 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {filtered.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-8">没有匹配的标签</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {filtered.map((t) => {
                const active = activeName === t.name
                return (
                  <button
                    key={t.name}
                    onClick={() => { onPick(t.name); onClose() }}
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs transition-colors ${
                      active
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-500/10'
                    }`}
                  >
                    <span className="text-gray-400">#</span>
                    <span className="truncate max-w-[160px]">{t.name}</span>
                    <span className="text-[10px] text-gray-400">{t.count}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
