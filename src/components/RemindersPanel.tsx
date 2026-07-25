import { useEffect, useState } from 'react'
import { splitReminders, formatRemindTime, type ReminderItem } from '../lib/reminders'

// 提醒面板(P10):顶栏铃铛打开,列出到期与即将到期的笔记提醒。
// 点击行打开笔记;「完成」清除该笔记的提醒(PUT remind_at=null)。

interface Props {
  token: string
  reminders: ReminderItem[]
  onClose: () => void
  onOpenArticle: (id: number) => void
  onChanged: () => void
}

export default function RemindersPanel({ token, reminders, onClose, onOpenArticle, onChanged }: Props) {
  const [now, setNow] = useState(() => Date.now())
  const [busyId, setBusyId] = useState<number | null>(null)

  // 面板打开期间每 30s 刷新一次「已到期」判定
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const { due, upcoming } = splitReminders(reminders, now)

  const clear = async (id: number) => {
    setBusyId(id)
    try {
      await fetch(`/api/articles/${id}/reminder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ remind_at: null }),
      })
      onChanged()
    } finally {
      setBusyId(null)
    }
  }

  const Row = ({ r }: { r: ReminderItem }) => (
    <div className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/40 group">
      <button
        onClick={() => { onOpenArticle(r.id); onClose() }}
        className="flex-1 min-w-0 text-left"
      >
        <div className="text-sm text-gray-800 dark:text-gray-100 truncate">{r.title || '(无标题)'}</div>
        <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2">
          <span className={isDueLabel(r.remind_at, now) ? 'text-red-500' : 'text-emerald-600'}>
            {formatRemindTime(r.remind_at, now)}
          </span>
          {r.notebook && <span className="truncate">· {r.notebook}</span>}
        </div>
      </button>
      <button
        onClick={() => clear(r.id)}
        disabled={busyId === r.id}
        className="shrink-0 text-[11px] px-2 py-1 rounded text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-500/10 disabled:opacity-40 transition-colors"
        title="标记完成(清除提醒)"
      >
        完成
      </button>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-end p-3" onMouseDown={onClose}>
      <div
        className="mt-11 w-80 max-w-[92vw] max-h-[70vh] bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-100 dark:border-gray-700 flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
            </svg>
            提醒
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {reminders.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-gray-400 leading-relaxed">
              暂无提醒。<br />在笔记编辑器顶栏点「提醒」为笔记设置提醒时间。
            </div>
          ) : (
            <>
              {due.length > 0 && (
                <div>
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-red-500 uppercase tracking-wider">已到期 {due.length}</div>
                  {due.map((r) => <Row key={r.id} r={r} />)}
                </div>
              )}
              {upcoming.length > 0 && (
                <div>
                  <div className="px-4 pt-3 pb-1 text-[11px] font-semibold text-gray-400 uppercase tracking-wider">即将到期 {upcoming.length}</div>
                  {upcoming.map((r) => <Row key={r.id} r={r} />)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// 行内到期判定(供颜色用;与 splitReminders 一致)
function isDueLabel(remindAt: string, now: number): boolean {
  return formatRemindTime(remindAt, now) === '已到期'
}
