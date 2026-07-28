import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import {
  defaultLayout, parseBlogLayout, serializeBlogLayout, locateWidget, contentWidth, hasSide,
  toggleWidget, updateWidget, updatePageSettings, moveWidget, addWidget, removeWidget,
  menuHref, addMenuItem, updateMenuItem, removeMenuItem, moveMenuItem,
  SLOTS, SLOT_LABELS, PAGES, PAGE_LABELS, WIDGET_TYPES, WIDGET_LABELS, NARROW_LABELS,
  MENU_ITEM_TYPES, MENU_TYPE_LABELS, MENU_VALUE_HINTS,
  BLOG_LAYOUT_KEY, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH, CONTENT_WARN_BELOW,
  type BlogLayout, type PageName, type SlotName, type Widget, type NarrowMode, type MenuItemType,
} from '../lib/blogLayout'

// 页面布局(P12.1 骨架;P12.2 加左栏/拖拽/宽度/窄屏降级/更多模块;P12.3 加导航菜单):
// 博客管理下的第三个子视图。列表页/详情页各一套,模块摆进「顶部 / 左侧栏 / 右侧栏 / 底部」四个槽位;
// 另有一页配置博客顶栏菜单。整份配置存 settings 表的 blog_layout 键(一个 JSON 字符串),
// 复用既有的 GET/PUT /api/settings,无 schema 改动。

interface Props {
  token: string
}

/** 三个页签:两个页面布局 + 导航菜单 */
type Tab = PageName | 'menu'

export default function BlogLayoutPanel({ token }: Props) {
  const api = useApi(token)
  const [tab, setTab] = useState<Tab>('list')
  const [layout, setLayout] = useState<BlogLayout | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  // 拖拽中的模块 id 与当前悬停的槽位(仅用于高亮)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overSlot, setOverSlot] = useState<SlotName | null>(null)
  // 菜单页签下仍需要一个「当前页面」用于模块操作的类型收敛;菜单页不显示模块区
  const page: PageName = tab === 'menu' ? 'list' : tab

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

  /**
   * 落点计算:拖到某一行 = 插到该行之前;拖到槽位空白 = 追加到末尾。
   * moveWidget 是「先摘出再插入」,所以同槽位且源在目标之前时下标要减 1,
   * 否则视觉上会比预期少挪一位。
   */
  const drop = (toSlot: SlotName, rowIndex: number | null) => {
    if (!layout || !dragId) return
    const from = locateWidget(layout[page], dragId)
    const id = dragId
    setDragId(null)
    setOverSlot(null)
    if (!from) return
    let to = rowIndex ?? layout[page][toSlot].length
    if (from.slot === toSlot && from.index < to) to -= 1
    if (from.slot === toSlot && from.index === to) return
    edit((l) => moveWidget(l, page, id, toSlot, to))
  }

  const cur = layout?.[page]
  const width = cur ? contentWidth(cur) : 0
  const tooNarrow = width < CONTENT_WARN_BELOW

  // ---- 导航菜单编辑(P12.3)----
  const menuEditor = (l: BlogLayout) => (
    <div className="max-w-3xl space-y-2">
      <p className="text-[11px] text-gray-400 leading-relaxed">
        博客顶栏菜单,从上到下即从左到右。窄屏会自动收进汉堡按钮。
        「单页」指向某篇已公开的笔记(比如写一篇「关于我」公开后挂上来),「标签」指向按该标签筛选后的列表。
        配置跟着页面布局一起下发,不额外占用请求。
      </p>

      {l.menu.length === 0 && (
        <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
          一个菜单项都没有,博客顶栏将只剩 Logo。
        </p>
      )}

      <ul className="space-y-1.5">
        {l.menu.map((m, i) => {
          const bad = menuHref(m) === null
          return (
            <li key={m.id} className={`px-3 py-2 rounded-lg border ${bad ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200 bg-white'}`}>
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={m.type}
                  onChange={(e) => edit((x) => updateMenuItem(x, m.id, { type: e.target.value as MenuItemType }))}
                  className="text-xs border border-gray-200 rounded px-1.5 py-1 text-gray-600 outline-none focus:border-emerald-400"
                >
                  {MENU_ITEM_TYPES.map((t) => (
                    <option key={t} value={t}>{MENU_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                <input
                  value={m.label}
                  onChange={(e) => edit((x) => updateMenuItem(x, m.id, { label: e.target.value }))}
                  placeholder="显示文字"
                  className="w-28 text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
                />
                {m.type !== 'home' && (
                  <input
                    value={m.value}
                    onChange={(e) => edit((x) => updateMenuItem(x, m.id, { value: e.target.value }))}
                    placeholder={MENU_VALUE_HINTS[m.type]}
                    className="flex-1 min-w-[12rem] text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
                  />
                )}
                <button onClick={() => edit((x) => moveMenuItem(x, m.id, -1))} disabled={i === 0} className="text-xs text-gray-400 hover:text-emerald-600 disabled:opacity-30" title="上移">↑</button>
                <button onClick={() => edit((x) => moveMenuItem(x, m.id, 1))} disabled={i === l.menu.length - 1} className="text-xs text-gray-400 hover:text-emerald-600 disabled:opacity-30" title="下移">↓</button>
                <button onClick={() => edit((x) => removeMenuItem(x, m.id))} className="text-xs text-gray-400 hover:text-red-500" title="删除该菜单项">✕</button>
              </div>
              {bad && (
                <p className="text-[11px] text-amber-600 mt-1">
                  {m.type === 'link' ? '链接只支持 http(s):// 或站内 / 开头的路径' : `还没填${MENU_VALUE_HINTS[m.type]}`}——该项不会显示在博客上
                </p>
              )}
            </li>
          )
        })}
      </ul>

      <select
        value=""
        onChange={(e) => { if (e.target.value) edit((x) => addMenuItem(x, e.target.value as MenuItemType)) }}
        className="text-xs border border-gray-200 rounded px-2 py-1 text-gray-500 outline-none focus:border-emerald-400"
      >
        <option value="">+ 添加菜单项</option>
        {MENU_ITEM_TYPES.map((t) => (
          <option key={t} value={t}>{MENU_TYPE_LABELS[t]}</option>
        ))}
      </select>
    </div>
  )

  const widgetRow = (w: Widget, slot: SlotName, i: number, total: number) => (
    <li
      key={w.id}
      draggable
      onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={() => { setDragId(null); setOverSlot(null) }}
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); setOverSlot(slot) } }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(slot, i) }}
      className={`px-3 py-2 rounded-lg border cursor-move transition-opacity ${
        dragId === w.id ? 'opacity-40' : ''
      } ${w.enabled ? 'border-gray-200 bg-white' : 'border-dashed border-gray-200 bg-gray-50'}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-gray-300 shrink-0 select-none" title="拖动排序或换槽位">⠿</span>
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
              placeholder={w.type === 'hot' ? '热榜自带日/周/月切换,通常留空' : ''}
              className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400"
            />
          </label>

          {(w.type === 'about' || w.type === 'markdown') && (
            <label className="block">
              <span className="text-[11px] text-gray-400">
                {w.type === 'markdown' ? '正文(支持 Markdown:标题/列表/链接/图片/代码块)' : '正文(纯文本,换行保留)'}
              </span>
              <textarea
                value={w.options.text || ''}
                onChange={(e) => edit((l) => updateWidget(l, page, w.id, { options: { ...w.options, text: e.target.value } }))}
                rows={5}
                className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 resize-y font-mono"
              />
            </label>
          )}

          {w.type === 'recent' && (
            <label className="block">
              <span className="text-[11px] text-gray-400">显示条数(1–20)</span>
              <input
                type="number"
                min={1}
                max={20}
                value={w.options.count || '8'}
                onChange={(e) => edit((l) => updateWidget(l, page, w.id, { options: { ...w.options, count: e.target.value } }))}
                className="w-24 text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 block"
              />
            </label>
          )}

          {w.type === 'links' && (
            <label className="block">
              <span className="text-[11px] text-gray-400">一行一条,格式「名称|链接」(仅支持 http(s) 与站内 / 开头的路径)</span>
              <textarea
                value={w.options.items || ''}
                onChange={(e) => edit((l) => updateWidget(l, page, w.id, { options: { ...w.options, items: e.target.value } }))}
                rows={4}
                placeholder={'Cloudflare|https://www.cloudflare.com\n我的另一个站|https://example.com'}
                className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 resize-y font-mono"
              />
            </label>
          )}

          {w.type === 'tags' && <p className="text-[11px] text-gray-400">自动统计全部公开文章的笔记本与标签(取前 30),点击标签会跳到按该标签筛选的列表,无需配置。</p>}

          {w.type === 'search' && (
            <label className="block">
              <span className="text-[11px] text-gray-400">输入框提示文字</span>
              <input
                value={w.options.placeholder || ''}
                onChange={(e) => edit((l) => updateWidget(l, page, w.id, { options: { ...w.options, placeholder: e.target.value } }))}
                placeholder="搜索文章…"
                className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400"
              />
              <span className="text-[11px] text-gray-400 block mt-1">搜索标题与正文,结果页地址形如 /blog?q=关键词。</span>
            </label>
          )}

          <div className="flex items-center gap-2 flex-wrap">
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
          <button key={p} onClick={() => { setTab(p); setEditing(null) }} className={`text-xs px-2.5 py-1 rounded-lg ${tab === p ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
            {PAGE_LABELS[p]}
          </button>
        ))}
        <button onClick={() => { setTab('menu'); setEditing(null) }} className={`text-xs px-2.5 py-1 rounded-lg ${tab === 'menu' ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
          导航菜单
        </button>

        {cur && tab !== 'menu' && (
          <>
            {/* 正文剩余宽度实时提示:左右同开最容易把正文压得没法看 */}
            <span className={`text-[11px] ml-2 px-2 py-0.5 rounded ${tooNarrow ? 'bg-amber-100 text-amber-700' : 'text-gray-400'}`}>
              正文宽约 {width}px{tooNarrow ? ' · 偏窄,代码块和表格会难看' : ''}
            </span>
            <label className="text-[11px] text-gray-400 flex items-center gap-1 ml-2">
              窄屏侧栏
              <select
                value={cur.narrow}
                onChange={(e) => edit((l) => updatePageSettings(l, page, { narrow: e.target.value as NarrowMode }))}
                className="text-[11px] border border-gray-200 rounded px-1 py-0.5 text-gray-600 outline-none focus:border-emerald-400"
              >
                {(Object.keys(NARROW_LABELS) as NarrowMode[]).map((m) => (
                  <option key={m} value={m}>{NARROW_LABELS[m]}</option>
                ))}
              </select>
            </label>
          </>
        )}

        {notice && <span className="text-xs text-emerald-600 ml-auto">{notice}</span>}
        <button onClick={reset} className={`text-xs text-gray-400 hover:text-gray-700 ${notice ? '' : 'ml-auto'}`}>恢复默认</button>
        <button onClick={save} disabled={saving || !dirty} className="text-xs px-3 py-1 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50">
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {!cur || !layout ? (
          <div className="py-20 flex justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : tab === 'menu' ? (
          menuEditor(layout)
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {SLOTS.map((s) => {
              const side = s === 'left' || s === 'right'
              return (
                <div
                  key={s}
                  onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverSlot(s) } }}
                  onDragLeave={() => setOverSlot((cs) => (cs === s ? null : cs))}
                  onDrop={(e) => { e.preventDefault(); drop(s, null) }}
                  className={`border rounded-lg p-2 flex flex-col min-h-[180px] transition-colors ${
                    overSlot === s ? 'border-emerald-400 bg-emerald-50/40' : 'border-gray-100'
                  }`}
                >
                  <div className="flex items-center justify-between px-1 pb-2">
                    <span className="text-xs font-medium text-gray-600">
                      {SLOT_LABELS[s]}
                      <span className="text-[11px] text-gray-400 ml-1">{side ? '(窄屏按上面的设置降级)' : '(全宽)'}</span>
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

                  {/* 侧栏宽度:只有该侧真的有启用模块时才影响正文,故未启用时给出说明 */}
                  {side && (
                    <label className="px-1 pb-2 flex items-center gap-2 text-[11px] text-gray-400">
                      <span className="shrink-0">宽度</span>
                      <input
                        type="range"
                        min={MIN_SIDE_WIDTH}
                        max={MAX_SIDE_WIDTH}
                        step={10}
                        value={s === 'left' ? cur.leftWidth : cur.rightWidth}
                        onChange={(e) => edit((l) => updatePageSettings(l, page, s === 'left' ? { leftWidth: Number(e.target.value) } : { rightWidth: Number(e.target.value) }))}
                        className="flex-1 min-w-0 accent-emerald-500"
                      />
                      <span className="shrink-0 tabular-nums w-10 text-right">{s === 'left' ? cur.leftWidth : cur.rightWidth}</span>
                      {!hasSide(cur, s) && <span className="shrink-0 text-gray-300">未启用</span>}
                    </label>
                  )}

                  {cur[s].length === 0 ? (
                    <div className="flex-1 flex items-center justify-center text-[11px] text-gray-300">拖模块到这里</div>
                  ) : (
                    <ul className="space-y-1.5">{cur[s].map((w, i) => widgetRow(w, s, i, cur[s].length))}</ul>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
