import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { marked } from '../lib/markdown'
import ConfirmDialog from './ConfirmDialog'
import {
  fmtDue, describeRule, TIME_UNITS, UNIT_LABEL, PRIORITY_LABEL, PRIORITY_MARK,
  OVERDUE_MAX_REMINDS, type TimeUnit,
} from '../lib/todoRules'
import type { Todo, TodoBucket, TodoListResponse, TodoCounts } from '../lib/todoTypes'

// 待办面板(P18)。这个模块的重点是通知,所以界面上处处把「提醒会不会到」摆在明面:
// 没有渠道时顶部常驻警告,每一行显示这条的提醒规则与推送状态。
// 一个设了提醒却永远不会响的待办,比没有提醒更坏——人以为自己被兜住了。

interface Props {
  token: string
  onClose: () => void
  onOpenArticle?: (id: number) => void
  onOpenSettings?: () => void
}

const BUCKETS: { id: TodoBucket; label: string; accent: string }[] = [
  { id: 'pending', label: '待办', accent: 'text-blue-600 border-blue-500' },
  { id: 'overdue', label: '已逾期', accent: 'text-red-600 border-red-500' },
  { id: 'done', label: '已完成', accent: 'text-emerald-600 border-emerald-500' },
]

type Draft = {
  id?: number
  title: string
  summary: string
  notes: string
  priority: number
  due_at: string
  lead_n: number
  lead_unit: TimeUnit
  repeat_n: number
  repeat_unit: TimeUnit
}

/** UTC ISO → datetime-local 需要的本地时间字符串(YYYY-MM-DDTHH:mm) */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z')
  if (!Number.isFinite(t)) return ''
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

const emptyDraft = (): Draft => ({
  title: '', summary: '', notes: '', priority: 1, due_at: '',
  lead_n: 0, lead_unit: 'day', repeat_n: 0, repeat_unit: 'week',
})

const toDraft = (t: Todo): Draft => ({
  id: t.id,
  title: t.title,
  summary: t.summary || '',
  notes: t.notes || '',
  priority: t.priority ?? 1,
  due_at: toLocalInput(t.due_at),
  lead_n: t.lead_n || 0,
  lead_unit: (t.lead_unit || 'day') as TimeUnit,
  repeat_n: t.repeat_n || 0,
  repeat_unit: (t.repeat_unit || 'week') as TimeUnit,
})

export default function TodosPanel({ token, onClose, onOpenArticle, onOpenSettings }: Props) {
  const api = useApi(token)
  const [bucket, setBucket] = useState<TodoBucket>('pending')
  const [todos, setTodos] = useState<Todo[] | null>(null)
  const [counts, setCounts] = useState<TodoCounts>({ pending: 0, overdue: 0, done: 0 })
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<Todo | null>(null)
  const [expanded, setExpanded] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [hasChannel, setHasChannel] = useState<boolean | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !draft && !deleting) onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose, draft, deleting])

  // 「已到期」是随时间变的:面板开着也要跟着走,否则刚过截止时间的那条还显示「剩 1 分钟」
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000)
    return () => clearInterval(t)
  }, [])

  const load = useCallback(async (b: TodoBucket) => {
    setError('')
    const res = await api.get<TodoListResponse>(`/todos?bucket=${b}`)
    if (res.ok && res.data) { setTodos(res.data.todos); setCounts(res.data.counts) }
    else { setError(res.error || '加载失败'); setTodos([]) }
  }, [api])

  useEffect(() => { load(bucket) }, [load, bucket])

  // 渠道自检。这是这个模块最要紧的一条前置条件,所以单独查一次而不是等推送失败——
  // 推送失败是在服务端日志里,而人是在这个面板里
  useEffect(() => {
    api.get<{ channels: { enabled?: boolean }[] }>('/notify/channels').then((r) => {
      setHasChannel(r.ok && Array.isArray(r.data?.channels) && r.data!.channels.some((c) => c?.enabled))
    })
  }, [api])

  const flash = (msg: string) => { setNote(msg); setTimeout(() => setNote(''), 4000) }

  const save = async () => {
    if (!draft) return
    const title = draft.title.trim()
    if (!title) { setError('标题不能为空'); return }
    setBusy(-1)
    const body = {
      title,
      summary: draft.summary,
      notes: draft.notes,
      priority: draft.priority,
      // datetime-local 给的是本地时间,转成 UTC 再发;清空则显式发 null
      due_at: draft.due_at ? new Date(draft.due_at).toISOString() : null,
      lead_n: draft.lead_n, lead_unit: draft.lead_unit,
      repeat_n: draft.repeat_n, repeat_unit: draft.repeat_unit,
      tz_offset: -new Date().getTimezoneOffset(),
    }
    const res = draft.id
      ? await api.put<{ todo: Todo }>(`/todos/${draft.id}`, body)
      : await api.post<{ todo: Todo }>('/todos', body)
    setBusy(null)
    if (!res.ok) { setError(res.error || '保存失败'); return }
    setDraft(null)
    load(bucket)
  }

  const markDone = async (t: Todo) => {
    setBusy(t.id)
    const res = await api.post<{ todo: Todo; next: Todo | null }>(`/todos/${t.id}/done`, {})
    setBusy(null)
    if (!res.ok) { setError(res.error || '操作失败'); return }
    if (res.data?.next) flash(`已完成。按周期生成了下一条,截止 ${fmtDue(res.data.next.due_at, Date.now())}`)
    load(bucket)
  }

  const reopen = async (t: Todo) => {
    setBusy(t.id)
    const res = await api.put<{ todo: Todo }>(`/todos/${t.id}`, { status: 'pending' })
    setBusy(null)
    if (!res.ok) { setError(res.error || '操作失败'); return }
    load(bucket)
  }

  const doDelete = async () => {
    if (!deleting) return
    const res = await api.del(`/todos/${deleting.id}`)
    setDeleting(null)
    if (!res.ok) { setError(res.error || '删除失败'); return }
    load(bucket)
  }

  return (
    // 右侧抽屉而不是居中弹窗。待办是「边做边看」的东西——在写笔记时想确认今天还剩什么,
    // 居中弹窗把正文整个盖住,抽屉只推开一条边。设置/统计/日志是「专门去一趟再回来」,
    // 那些仍然居中。形状上也更合:待办是一列纵向条目,居中的 3xl 框横向全是留白、纵向反而挤。
    // 窄屏铺满整宽,等价于全屏覆盖层。
    <div className="fixed inset-0 z-[70] flex justify-end" onMouseDown={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="cfnote-drawer relative bg-white dark:bg-gray-800 shadow-2xl w-full sm:w-[26rem] h-full flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">待办事项</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => { setDraft(emptyDraft()); setError('') }}
              className="text-xs px-2.5 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white transition-colors"
            >
              新建
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
          </div>
        </div>

        <NoChannelBanner has={hasChannel} onOpenSettings={onOpenSettings} />

        <div className="px-4 pt-3 flex gap-1 shrink-0 border-b border-gray-100 dark:border-gray-700">
          {BUCKETS.map((b) => (
            <button
              key={b.id}
              onClick={() => setBucket(b.id)}
              className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
                bucket === b.id ? b.accent : 'border-transparent text-gray-400 hover:text-gray-600'
              }`}
            >
              {b.label}
              <span className="ml-1 opacity-70">{counts[b.id as keyof TodoCounts] ?? 0}</span>
            </button>
          ))}
        </div>

        {error && <div className="mx-4 mt-3 text-xs text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        {note && <div className="mx-4 mt-3 text-xs text-emerald-700 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg px-3 py-2">{note}</div>}

        <div className="flex-1 min-h-0 overflow-y-auto">
          {todos === null ? (
            <div className="px-4 py-10 text-center text-xs text-gray-400">加载中…</div>
          ) : todos.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-gray-400 leading-relaxed">
              {bucket === 'done' ? '还没有完成任何待办。' : bucket === 'overdue' ? '没有逾期的待办。' : '还没有待办。点右上角「新建」。'}
            </div>
          ) : (
            todos.map((t) => (
              <TodoRow
                key={t.id}
                t={t}
                now={now}
                busy={busy === t.id}
                expanded={expanded === t.id}
                onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
                onDone={() => markDone(t)}
                onReopen={() => reopen(t)}
                onEdit={() => { setDraft(toDraft(t)); setError('') }}
                onDelete={() => setDeleting(t)}
                onOpenArticle={onOpenArticle}
              />
            ))
          )}
        </div>
      </div>

      {draft && (
        <DraftDialog
          draft={draft}
          busy={busy === -1}
          onChange={setDraft}
          onSave={save}
          onCancel={() => { setDraft(null); setError('') }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="删除这条待办"
          message={`「${deleting.title}」会被移入软删除状态,不再出现在任何列表里。`}
          onConfirm={doDelete}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  )
}
// 没有渠道时的横幅。刻意做成常驻而不是可关闭的提示:
// 它描述的是「你设的提醒不会到」这个持续状态,不是一次性事件。
// 也刻意不拦住创建待办——只想记一下事情的场景是合理的
function NoChannelBanner({ has, onOpenSettings }: { has: boolean | null; onOpenSettings?: () => void }) {
  if (has !== false) return null
  return (
    <div className="mx-4 mt-3 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 px-3 py-2.5 shrink-0">
      <div className="text-xs text-amber-800 dark:text-amber-200 leading-relaxed">
        <b>还没有启用任何通知渠道。</b>待办可以照常记录,但<b>到时间不会有任何提醒</b>——
        推送要走 Telegram / 企业微信 / 飞书 / 钉钉 / Server酱 / 自定义 Webhook 里的至少一个。
      </div>
      {onOpenSettings && (
        <button
          onClick={onOpenSettings}
          className="mt-1.5 text-xs font-medium text-amber-900 dark:text-amber-100 underline hover:no-underline"
        >
          去「设置 → 通知」配一个
        </button>
      )}
    </div>
  )
}

interface RowProps {
  t: Todo
  now: number
  busy: boolean
  expanded: boolean
  onToggle: () => void
  onDone: () => void
  onReopen: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenArticle?: (id: number) => void
}

function TodoRow({ t, now, busy, expanded, onToggle, onDone, onReopen, onEdit, onDelete, onOpenArticle }: RowProps) {
  const done = t.status === 'done'
  const dueTs = t.due_at ? Date.parse(t.due_at.includes('T') ? t.due_at : t.due_at.replace(' ', 'T') + 'Z') : NaN
  const overdue = !done && Number.isFinite(dueTs) && dueTs <= now
  const mark = PRIORITY_MARK[t.priority] || ''

  return (
    <div className={`px-4 py-2.5 border-b border-gray-50 dark:border-gray-700/50 group ${busy ? 'opacity-50' : ''}`}>
      <div className="flex items-start gap-2.5">
        <button
          onClick={done ? onReopen : onDone}
          disabled={busy}
          title={done ? '重新打开' : '标记完成'}
          className={`mt-0.5 w-4 h-4 rounded shrink-0 border-2 flex items-center justify-center transition-colors ${
            done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-gray-300 hover:border-emerald-500'
          }`}
        >
          {done && (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        <button onClick={onToggle} className="flex-1 min-w-0 text-left">
          <div className="flex items-center gap-1.5 flex-wrap">
            {mark && <span className="text-[10px] shrink-0" title={PRIORITY_LABEL[t.priority]}>{mark}</span>}
            <span className={`text-sm ${done ? 'line-through text-gray-400' : 'text-gray-800 dark:text-gray-100'}`}>
              {t.title || '(无标题)'}
            </span>
          </div>
          {t.summary && <div className="text-[11px] text-gray-500 mt-0.5 truncate">{t.summary}</div>}
          <div className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
            {t.due_at && (
              <span className={overdue ? 'text-red-500 font-medium' : 'text-gray-400'}>
                {fmtDue(t.due_at, now)}
              </span>
            )}
            <RemindBadge t={t} overdue={overdue} done={done} />
          </div>
        </button>

        {/* 抽屉窄,且触屏上没有 hover——操作按钮常显。
            居中弹窗那版是 hover 才现形的,搬进抽屉后那样等于在手机上够不到 */}
        <div className="shrink-0 flex items-center gap-1">
          <button onClick={onEdit} className="text-[11px] px-2 py-1 rounded text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-500/10">编辑</button>
          <button onClick={onDelete} className="text-[11px] px-2 py-1 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10">删除</button>
        </div>
      </div>

      {expanded && (
        <div className="mt-2 ml-6 pl-3 border-l-2 border-gray-100 dark:border-gray-700 space-y-2">
          <div className="text-[11px] text-gray-500">{describeRule(t)}</div>
          {t.notes && (
            <div
              className="prose prose-sm dark:prose-invert max-w-none text-xs"
              dangerouslySetInnerHTML={{ __html: marked(t.notes) as string }}
            />
          )}
          {t.article_id && onOpenArticle && (
            <button
              onClick={() => onOpenArticle(t.article_id!)}
              className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
            >
              打开关联的笔记 →
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// 推送状态角标。这是「重点是通知」在界面上的落点:
// 一条设了提醒的待办,人应该能一眼看出它响过没有、还会不会再响
function RemindBadge({ t, overdue, done }: { t: Todo; overdue: boolean; done: boolean }) {
  if (done) return null
  const hasRule = !!t.remind_at || !!t.due_at
  if (!hasRule) return <span className="text-gray-300">未设提醒</span>

  if (overdue) {
    const n = t.overdue_reminds || 0
    if (n >= OVERDUE_MAX_REMINDS) {
      return <span className="text-gray-400" title="逾期提醒已用完,不会再推送">已提醒 {n} 次 · 不再提醒</span>
    }
    return <span className="text-amber-600">逾期提醒 {n}/{OVERDUE_MAX_REMINDS}</span>
  }

  if (t.reminded_at) return <span className="text-emerald-600">已提醒</span>
  return <span className="text-gray-400">待提醒</span>
}
interface DraftProps {
  draft: Draft
  busy: boolean
  onChange: (d: Draft) => void
  onSave: () => void
  onCancel: () => void
}

function DraftDialog({ draft, busy, onChange, onSave, onCancel }: DraftProps) {
  const [preview, setPreview] = useState(false)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v })

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel() } }
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [onCancel])

  const field = 'w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 rounded-lg px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:border-transparent'
  const label = 'block text-[11px] font-medium text-gray-500 mb-1'

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-3" onMouseDown={onCancel}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-700 shrink-0">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
            {draft.id ? '编辑待办' : '新建待办'}
          </h3>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          <div>
            <label className={label}>标题</label>
            <input autoFocus value={draft.title} onChange={(e) => set('title', e.target.value)} className={field} />
          </div>

          <div>
            <label className={label}>简介</label>
            <input value={draft.summary} onChange={(e) => set('summary', e.target.value)} className={field}
                   placeholder="一句话说清这件事(会一起推送到通知里)" />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className={label}>优先级</label>
              <select value={draft.priority} onChange={(e) => set('priority', Number(e.target.value))} className={field}>
                {[0, 1, 2, 3].map((p) => (
                  <option key={p} value={p}>{PRIORITY_MARK[p]} {PRIORITY_LABEL[p]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={label}>截止时间</label>
              <input type="datetime-local" value={draft.due_at} onChange={(e) => set('due_at', e.target.value)} className={field} />
            </div>
          </div>

          <div className="rounded-lg bg-gray-50 dark:bg-gray-700/40 p-3 space-y-3">
            <div>
              <label className={label}>提前多久提醒</label>
              <div className="flex gap-2">
                <input
                  type="number" min={0} max={999} value={draft.lead_n}
                  onChange={(e) => set('lead_n', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className={field + ' w-20'}
                />
                <select value={draft.lead_unit} onChange={(e) => set('lead_unit', e.target.value as TimeUnit)} className={field}>
                  {TIME_UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
                </select>
              </div>
              <div className="text-[11px] text-gray-400 mt-1">
                填 0 = 到截止时间才提醒。没有截止时间的话提醒不会触发。
              </div>
            </div>

            <div>
              <label className={label}>完成后按周期重复</label>
              <div className="flex gap-2">
                <input
                  type="number" min={0} max={999} value={draft.repeat_n}
                  onChange={(e) => set('repeat_n', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
                  className={field + ' w-20'}
                />
                <select value={draft.repeat_unit} onChange={(e) => set('repeat_unit', e.target.value as TimeUnit)} className={field}>
                  {TIME_UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u]}</option>)}
                </select>
              </div>
              <div className="text-[11px] text-gray-400 mt-1">
                填 0 = 一次性。下一条从<b>这次的截止时间</b>往后推,不是从完成时刻——否则晚做一天整个周期就漂一天。
              </div>
            </div>

            <div className="text-[11px] text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-500/10 rounded px-2 py-1.5">
              {describeRule({
                due_at: draft.due_at ? new Date(draft.due_at).toISOString() : null,
                lead_n: draft.lead_n, lead_unit: draft.lead_unit,
                repeat_n: draft.repeat_n, repeat_unit: draft.repeat_unit,
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={label + ' mb-0'}>备注（Markdown，可插图片链接）</label>
              <button
                onClick={() => setPreview(!preview)}
                className="text-[11px] text-gray-400 hover:text-gray-600"
              >
                {preview ? '编辑' : '预览'}
              </button>
            </div>
            {preview ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none text-xs border border-gray-200 dark:border-gray-600 rounded-lg px-2.5 py-2 min-h-[6rem]"
                dangerouslySetInnerHTML={{ __html: marked(draft.notes || '_(空)_') as string }}
              />
            ) : (
              <textarea
                value={draft.notes} onChange={(e) => set('notes', e.target.value)} rows={5}
                className={field + ' font-mono text-xs resize-y'}
                placeholder={'支持 Markdown:\n- 列表\n**粗体**\n![图](图片地址)'}
              />
            )}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-gray-100 dark:border-gray-700 flex justify-end gap-2 shrink-0">
          <button onClick={onCancel} className="px-3.5 py-1.5 text-sm rounded-lg text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
            取消
          </button>
          <button
            onClick={onSave} disabled={busy || !draft.title.trim()}
            className="px-3.5 py-1.5 text-sm rounded-lg text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}


