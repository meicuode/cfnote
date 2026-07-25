import { useEffect, useState } from 'react'

// 版本历史对话框(P10,懒加载):列出某篇笔记的历史快照,可预览与恢复。
// 恢复不单独走后端——把选中版本的标题/正文/标签交回编辑器作为当前工作副本,
// 由编辑器既有保存链路落库(从而再生成一版,天然可追溯)。

interface VersionMeta {
  id: number
  title: string
  chars: number
  created_at: string
}
interface VersionFull {
  id: number
  title: string
  content: string
  tags: string | null
  created_at: string
}

// D1 时间为 UTC 无时区标记,补 Z 再转本地
function toLocal(d: string): string {
  const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(d) ? d : d.replace(' ', 'T') + 'Z')
  if (isNaN(t.getTime())) return d
  const p = (n: number) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}

function parseTags(tags: string | null): string[] {
  if (!tags) return []
  try {
    const v = JSON.parse(tags)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

interface Props {
  articleId: number
  token: string
  onClose: () => void
  onRestore: (v: { title: string; content: string; tags: string[] }) => void
}

export default function VersionHistoryDialog({ articleId, token, onClose, onRestore }: Props) {
  const [list, setList] = useState<VersionMeta[] | null>(null)
  const [selId, setSelId] = useState<number | null>(null)
  const [detail, setDetail] = useState<VersionFull | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    fetch(`/api/articles/${articleId}/versions`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json() as Promise<any>)
      .then((j) => {
        const data: VersionMeta[] = j.ok ? j.data : []
        setList(data)
        if (data.length) setSelId(data[0].id)
      })
      .catch(() => setList([]))
  }, [articleId, token])

  useEffect(() => {
    if (selId == null) { setDetail(null); return }
    setLoadingDetail(true)
    setDetail(null)
    fetch(`/api/articles/${articleId}/versions/${selId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json() as Promise<any>)
      .then((j) => { if (j.ok) setDetail(j.data) })
      .catch(() => {})
      .finally(() => setLoadingDetail(false))
  }, [selId, articleId, token])

  const doRestore = () => {
    if (!detail) return
    onRestore({ title: detail.title, content: detail.content, tags: parseTags(detail.tags) })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center p-4" onMouseDown={onClose}>
      <div
        className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[860px] max-w-[95vw] h-[80vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            版本历史
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* 版本列表 */}
          <div className="w-56 shrink-0 border-r border-gray-100 dark:border-gray-700 overflow-y-auto">
            {list === null ? (
              <div className="p-4 text-xs text-gray-400">加载中…</div>
            ) : list.length === 0 ? (
              <div className="p-4 text-xs text-gray-400 leading-relaxed">暂无历史版本。<br />编辑并保存后自动记录(每小时合并为一版)。</div>
            ) : (
              list.map((v, i) => (
                <button
                  key={v.id}
                  onClick={() => setSelId(v.id)}
                  className={`w-full text-left px-3 py-2.5 border-b border-gray-50 dark:border-gray-700/50 transition-colors ${
                    selId === v.id ? 'bg-emerald-50 dark:bg-emerald-500/10' : 'hover:bg-gray-50 dark:hover:bg-gray-700/40'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-gray-700 dark:text-gray-200">{toLocal(v.created_at)}</span>
                    {i === 0 && <span className="text-[10px] px-1 py-px rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">最新</span>}
                  </div>
                  <div className="text-[11px] text-gray-400 mt-0.5 truncate">{v.title || '(无标题)'} · {v.chars} 字</div>
                </button>
              ))
            )}
          </div>

          {/* 预览 */}
          <div className="flex-1 min-w-0 flex flex-col">
            {loadingDetail ? (
              <div className="flex-1 flex items-center justify-center text-xs text-gray-400">加载中…</div>
            ) : !detail ? (
              <div className="flex-1 flex items-center justify-center text-xs text-gray-400">选择左侧一个版本查看内容</div>
            ) : (
              <>
                <div className="px-5 pt-4 pb-2 shrink-0">
                  <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">{detail.title || '(无标题)'}</div>
                  <div className="text-[11px] text-gray-400 mt-1">
                    保存于 {toLocal(detail.created_at)}
                    {parseTags(detail.tags).length > 0 && <> · 标签:{parseTags(detail.tags).join('、')}</>}
                  </div>
                </div>
                <pre className="flex-1 overflow-auto mx-5 mb-2 p-3 text-xs font-mono whitespace-pre-wrap break-words bg-gray-50 dark:bg-gray-900/40 rounded-lg text-gray-700 dark:text-gray-300">
                  {detail.content || '(空内容)'}
                </pre>
              </>
            )}
            <div className="px-5 py-3 border-t border-gray-100 dark:border-gray-700 flex items-center justify-end gap-3 shrink-0">
              <button onClick={onClose} className="px-4 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
                关闭
              </button>
              <button
                onClick={() => setConfirming(true)}
                disabled={!detail}
                className="px-4 py-1.5 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-40"
              >
                恢复此版本
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirming && detail && (
        <div className="fixed inset-0 z-[90] bg-black/40 flex items-center justify-center p-4" onMouseDown={() => setConfirming(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-80 max-w-[92vw] p-5" onMouseDown={(e) => e.stopPropagation()}>
            <p className="text-sm text-gray-700 dark:text-gray-200">
              恢复到 <span className="font-medium">{toLocal(detail.created_at)}</span> 的版本?
            </p>
            <p className="text-xs text-gray-400 mt-2">当前内容会先作为一版保存进历史,可再次恢复。</p>
            <div className="mt-4 flex items-center justify-end gap-3">
              <button onClick={() => setConfirming(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
                取消
              </button>
              <button onClick={doRestore} className="px-4 py-1.5 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600">
                恢复
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
