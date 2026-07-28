import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import {
  defaultLayout, parseBlogLayout, serializeBlogLayout, locateWidget,
  toggleWidget, updateWidget, moveWidget, addWidget, removeWidget,
  SLOTS, SLOT_LABELS, PAGES, PAGE_LABELS, WIDGET_TYPES, WIDGET_LABELS, BLOG_LAYOUT_KEY,
  type BlogLayout, type PageName, type SlotName, type Widget,
} from '../lib/blogLayout'

// 页面布局配置(P12.1):博客管理下的第三个子视图。
// 列表页/详情页各一套,模块摆进「顶部 / 右侧栏 / 底部」三个槽位;左栏留给 P12.2(宽度问题见 blogLayout.ts 注释)。
// 存 settings 表的 blog_layout 键(一个 JSON 字符串),复用既有的 GET/PUT /api/settings,无 schema 改动。

interface Props {
  token: string
}

export default function BlogLayoutPanel({ token }: Props) {
  const api = useApi(token)
  const [page, setPage] = useState<PageName>('list')
  const [layout, setLayout] = useState<BlogLayout | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await api.get<Record<string, string>>('/settings')
    setLayout(parseBlogLayout(res.ok && res.data ? res.data[BLOG_LAYOUT_KEY] : ''))
    setDirty(false)
  }, [api])
  useEffect(() => { load() }, [load])

  const edit = (fn: (l: BlogLayout) => BlogLayout) => {
    setLayout((cur) => (cur ? fn(cur) : cur))
    setDirty(true)
  }

  const save = async () => {
    if (!layout) return
    setSaving(true)
    const res = await api.put('/settings', { [BLOG_LAYOUT_KEY]: serializeBlogLayout(layout) })
    setSaving(false)
    setNotice(res.ok ? '已保存,刷新博客页即可看到' : '保存失败')
    if (res.ok) setDirty(false)
    setTimeout(() => setNotice(''), 3000)
  }

  const reset = () => {
    setLayout(defaultLayout())
    setDirty(true)
    setNotice('已恢复默认(还需点保存)')
    setTimeout(() => setNotice(''), 3000)
  }

  // 上下移:同槽位内换位。摘出后再插入,所以下移传 index+1、上移传 index-1
  const shift = (w: Widget, delta: number) => {
    if (!layout) return
    const at = locateWidget(layout[page], w.id)
    if (!at) return
    const to = at.index + delta
    if (to < 0 || to >= layout[page][at.slot].length) return
    edit((l) => moveWidget(l, page, w.id, at.slot, to))
  }

  const cur = layout?.[page]

  const widgetRow = (w: Widget, slot: SlotName, i: number, total: number) => (
    <li key={w.id} className={`px-3 py-2 rounded-lg border ${w.enabled ? 'border-gray-200 bg-white' : 'border-dashed border-gray-200 bg-gray-50'}`}>
      <div className="flex items-center gap-2">
        <span className={`text-sm truncate flex-1 ${w.enabled ? 'text-gray-800' : 'text-gray-400 line-through'}`}>
          {WIDGET_LABELS[w.type]}
          {w.title && <span className="text-gray-400 text-xs ml-1">「{w.title}」</span>}
        </span>
        <button onClick={() => shift(w, -1)} disabled={i === 0} className="text-xs text-gray-400 hover:text-emerald-600 disabled:opacity-30" title="上移">↑</button>
        <button onClick={() => shift(w, 1)} disabled={i === total - 1} className="text-xs text-gray-400 hover:text-emerald-600 disabled:opacity-30" title="下移">↓</button>
        <button onClick={() => edit((l) => toggleWidget(l, page, w.id))} className="text-xs text-gray-500 hover:text-emerald-600" title={w.enabled ? '停用(保留配置)' : '启用'}>
          {w.enabled ? '停用' : '启用'}
        </button>
        <button onClick={() => setEditing(editing === w.id ? null : w.id)} className="text-xs text-emerald-600 hover:underline">
          {editing === w.id ? '收起' : '编辑'}
        </button>
        <button onClick={() => edit((l) => removeWidget(l, page, w.id))} className="text-xs text-gray-400 hover:text-red-500" title="删除该模块">✕</button>
      </div>

      {editing === w.id && (
        <div className="mt-2 space-y-2 border-t border-gray-100 pt-2">
          <label className="block">
            <span className="text-[11px] text-gray-400">标题(留空则不显示标题栏)</span>
            <input
              value={w.title}
              onChange={(e) => edit((l) => updateWidget(l, page, w.id, { title: e.target.value }))}
              placeholder={w.type === 'hot' ? '热榜自带日/周/月切换,通常留空' : '关于本站'}
              className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400"
            />
          </label>
          {w.type === 'about' && (
            <label className="block">
              <span className="text-[11px] text-gray-400">正文(纯文本,换行保留)</span>
              <textarea
                value={w.options.text || ''}
                onChange={(e) => edit((l) => updateWidget(l, page, w.id, { options: { ...w.options, text: e.target.value } }))}
                rows={4}
                className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 resize-y"
              />
            </label>
          )}
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-gray-400">移到槽位</span>
            {SLOTS.filter((s) => s !== slot).map((s) => (
              <button key={s} onClick={() => edit((l) => moveWidget(l, page, w.id, s, 99))} className="text-xs px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:border-emerald-400 hover:text-emerald-600">
                {SLOT_LABELS[s]}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  )

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0 flex-wrap">
        {PAGES.map((p) => (
          <button key={p} onClick={() => { setPage(p); setEditing(null) }} className={`text-xs px-2.5 py-1 rounded-lg ${page === p ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
            {PAGE_LABELS[p]}
          </button>
        ))}
        <span className="text-[11px] text-gray-400 ml-2">左侧栏在下一批支持(正文宽度需先可配)</span>
        {notice && <span className="text-xs text-emerald-600 ml-auto">{notice}</span>}
        <button onClick={reset} className={`text-xs text-gray-400 hover:text-gray-700 ${notice ? '' : 'ml-auto'}`}>恢复默认</button>
        <button onClick={save} disabled={saving || !dirty} className="text-xs px-3 py-1 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {!cur ? (
          <div className="py-20 flex justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            {SLOTS.map((s) => (
              <div key={s} className="border border-gray-100 rounded-lg p-2 flex flex-col min-h-[160px]">
                <div className="flex items-center justify-between px-1 pb-2">
                  <span className="text-xs font-medium text-gray-600">
                    {SLOT_LABELS[s]}
                    <span className="text-[11px] text-gray-400 ml-1">{s === 'right' ? '(窄屏隐藏)' : '(全宽)'}</span>
                  </span>
                  <select
                    value=""
                    onChange={(e) => { if (e.target.value) edit((l) => addWidget(l, page, s, e.target.value as any)) }}
                    className="text-[11px] border border-gray-200 rounded px-1 py-0.5 text-gray-500 outline-none focus:border-emerald-400"
                  >
                    <option value="">+ 添加</option>
                    {WIDGET_TYPES.map((t) => (<option key={t} value={t}>{WIDGET_LABELS[t]}</option>))}
                  </select>
                </div>
                {cur[s].length === 0 ? (
                  <div className="flex-1 flex items-center justify-center text-[11px] text-gray-300">空</div>
                ) : (
                  <ul className="space-y-1.5">{cur[s].map((w, i) => widgetRow(w, s, i, cur[s].length))}</ul>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
