import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import BlogPreview from './BlogPreview'
import {
  defaultLayout, parseBlogLayout, serializeBlogLayout, locateWidget, contentWidth, hasSide,
  toggleWidget, updateWidget, updatePageSettings, moveWidget, addWidget, removeWidget,
  menuHref, addMenuItem, updateMenuItem, removeMenuItem, moveMenuItem,
  widgetChoices, widgetWorksOn,
  SLOTS, SLOT_LABELS, PAGES, PAGE_LABELS, WIDGET_LABELS, NARROW_LABELS,
  MENU_ITEM_TYPES, MENU_TYPE_LABELS, MENU_VALUE_HINTS,
  BLOG_LAYOUT_KEY, MIN_SIDE_WIDTH, MAX_SIDE_WIDTH, CONTENT_WARN_BELOW,
  type BlogLayout, type PageName, type SlotName, type Widget, type NarrowMode, type MenuItemType, type WidgetType,
} from '../lib/blogLayout'
import {
  defaultSkin, parseBlogSkin, serializeBlogSkin, applyPreset, matchPreset, hoverColor, normalizeHex,
  SKIN_PRESETS, FONT_LABELS, LIST_STYLE_LABELS, BLOG_SKIN_KEY,
  MIN_RADIUS, MAX_RADIUS, MIN_FONT_SIZE, MAX_FONT_SIZE, MIN_WIDTH, MAX_WIDTH, MAX_CSS_LEN,
  type BlogSkin, type FontKey, type ListStyle,
} from '../lib/blogSkin'
import {
  THEME_LIBRARY_KEY, MAX_THEMES, MAX_THEME_NAME, parseThemeLibrary, serializeThemeLibrary,
  addTheme, updateTheme, renameTheme, removeTheme, exportThemeJson, themeFileName, parseImportedTheme,
  type SavedTheme,
} from '../lib/blogThemes'
import {
  ARTICLE_PART_LABELS, ARTICLE_PART_HINTS, DEFAULT_SOURCE_TEXT, DEFAULT_DIVIDER_TEXT, MAX_PART_TEXT,
  isPartLocked, partFlag, moveArticlePart, toggleArticlePart, setArticlePartOption,
  type ArticlePart,
} from '../lib/blogArticleParts'

// 页面布局(P12.1 骨架;P12.2 左栏/拖拽/宽度/窄屏降级;P12.3 导航菜单;P12.4 真预览 + 顶部/底部模块):
// 博客管理下的第三个子视图。左边摆模块(四个槽位竖排),右边是**真的博客页** iframe 实时预览
// (见 BlogPreview.tsx:为什么不画仿真示意图)。整份配置存 settings 表的 blog_layout 键,
// 复用既有的 GET/PUT /api/settings,无 schema 改动。

interface Props {
  token: string
}

/** 四个页签:两个页面布局 + 导航菜单 + 主题外观 */
type Tab = PageName | 'menu' | 'skin'

export default function BlogLayoutPanel({ token }: Props) {
  const api = useApi(token)
  const [tab, setTab] = useState<Tab>('list')
  const [layout, setLayout] = useState<BlogLayout | null>(null)
  const [skin, setSkin] = useState<BlogSkin>(defaultSkin)
  // 主题库(P12.7):管理端专用,存 settings.blog_skin_library。公开博客路径一行都不读它
  const [library, setLibrary] = useState<SavedTheme[]>([])
  const [newThemeName, setNewThemeName] = useState('')
  const [themeMsg, setThemeMsg] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  // 拖拽中的模块 id 与当前悬停的槽位(仅用于高亮)
  const [dragId, setDragId] = useState<string | null>(null)
  const [overSlot, setOverSlot] = useState<SlotName | null>(null)
  // 菜单/主题页签下仍需要一个「当前页面」用于模块操作的类型收敛与预览
  const page: PageName = tab === 'menu' || tab === 'skin' ? 'list' : tab

  const load = useCallback(async () => {
    const res = await api.get<Record<string, string>>('/settings')
    const s = res.ok && res.data ? res.data : {}
    setLayout(parseBlogLayout(s[BLOG_LAYOUT_KEY]))
    setSkin(parseBlogSkin(s[BLOG_SKIN_KEY]))
    setLibrary(parseThemeLibrary(s[THEME_LIBRARY_KEY]))
    setDirty(false)
  }, [api])
  useEffect(() => { load() }, [load])

  const edit = (fn: (l: BlogLayout) => BlogLayout) => {
    setLayout((cur) => (cur ? fn(cur) : cur))
    setDirty(true)
  }
  const editSkin = (fn: (s: BlogSkin) => BlogSkin) => {
    setSkin((cur) => fn(cur))
    setDirty(true)
  }
  const editLibrary = (fn: (l: SavedTheme[]) => SavedTheme[]) => {
    setLibrary((cur) => fn(cur))
    setDirty(true)
  }

  const flashTheme = (msg: string) => {
    setThemeMsg(msg)
    setTimeout(() => setThemeMsg(''), 5000)
  }

  const saveCurrentAsTheme = () => {
    if (library.length >= MAX_THEMES) return flashTheme(`最多保存 ${MAX_THEMES} 套主题`)
    editLibrary((l) => addTheme(l, newThemeName || '我的主题', skin))
    setNewThemeName('')
    flashTheme('已加入主题库(还需点右上角保存)')
  }

  const downloadTheme = (t: SavedTheme) => {
    const url = URL.createObjectURL(new Blob([exportThemeJson(t)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = themeFileName(t.name)
    a.click()
    URL.revokeObjectURL(url)
  }

  const importTheme = async (file: File) => {
    const r = parseImportedTheme(await file.text())
    if (!r.ok) return flashTheme('导入失败:' + r.error)
    if (library.length >= MAX_THEMES) return flashTheme(`最多保存 ${MAX_THEMES} 套主题`)
    editLibrary((l) => addTheme(l, r.name, r.skin))
    flashTheme(['已导入「' + r.name + '」(还需点右上角保存)', ...r.warnings].join('；'))
  }

  const save = async () => {
    if (!layout) return
    setSaving(true)
    // 布局与皮肤一次 PUT 写两个键(设置接口本就接受多键)
    const res = await api.put('/settings', {
      [BLOG_LAYOUT_KEY]: serializeBlogLayout(layout),
      [BLOG_SKIN_KEY]: serializeBlogSkin(skin),
      [THEME_LIBRARY_KEY]: serializeThemeLibrary(library),
    })
    setSaving(false)
    setNotice(res.ok ? '已保存,刷新博客页即可看到' : '保存失败')
    if (res.ok) setDirty(false)
    setTimeout(() => setNotice(''), 3000)
  }

  const reset = () => {
    // 只恢复当前页签管的那部分,免得改主题时把布局也一并清了
    if (tab === 'skin') setSkin(defaultSkin())
    else setLayout(defaultLayout())
    setDirty(true)
    setNotice(`已恢复${tab === 'skin' ? '默认主题' : '默认布局'}(还需点保存)`)
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
  const width = cur ? contentWidth(cur, skin.width) : 0
  const tooNarrow = width < CONTENT_WARN_BELOW

  // 预览里点了某个模块 → 展开它的编辑区并滚到可见处
  const selectWidget = useCallback((id: string) => {
    setEditing(id)
    setTimeout(() => document.getElementById(`wrow-${id}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 0)
  }, [])

  // ---- 模块选项的通用控件(都直接写回 layout,预览随之即时刷新)----
  const setOpt = (w: Widget, key: string, v: string) =>
    edit((l) => updateWidget(l, page, w.id, { options: { ...w.options, [key]: v } }))

  const optLabel = (text: string, node: React.ReactNode) => (
    <label className="block">
      <span className="text-[11px] text-gray-400">{text}</span>
      {node}
    </label>
  )
  const optText = (w: Widget, key: string, label: string, placeholder = '') =>
    optLabel(label, (
      <input
        value={w.options[key] || ''}
        onChange={(e) => setOpt(w, key, e.target.value)}
        placeholder={placeholder}
        className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400"
      />
    ))
  const optSelect = (w: Widget, key: string, label: string, opts: [string, string][], def: string) =>
    optLabel(label, (
      <select
        value={w.options[key] || def}
        onChange={(e) => setOpt(w, key, e.target.value)}
        className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400"
      >
        {opts.map(([v, t]) => (<option key={v} value={v}>{t}</option>))}
      </select>
    ))
  const optNumber = (w: Widget, key: string, label: string, min: number, max: number, def: string) =>
    optLabel(label, (
      <input
        type="number"
        min={min}
        max={max}
        value={w.options[key] || def}
        onChange={(e) => setOpt(w, key, e.target.value)}
        className="w-24 text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 block"
      />
    ))
  const optCheck = (w: Widget, key: string, label: string, def: string) => (
    <label className="flex items-center gap-1.5 text-[11px] text-gray-500">
      <input
        type="checkbox"
        checked={(w.options[key] ?? def) === '1'}
        onChange={(e) => setOpt(w, key, e.target.checked ? '1' : '0')}
        className="accent-emerald-500"
      />
      {label}
    </label>
  )

  /** 每种模块自己的表单 */
  const widgetOptions = (w: Widget) => {
    switch (w.type) {
      case 'about':
      case 'markdown':
        return optLabel(
          w.type === 'markdown' ? '正文(支持 Markdown:标题/列表/链接/图片/代码块)' : '正文(纯文本,换行保留)',
          <textarea
            value={w.options.text || ''}
            onChange={(e) => setOpt(w, 'text', e.target.value)}
            rows={5}
            className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 resize-y font-mono"
          />
        )
      case 'recent':
        return optNumber(w, 'count', '显示条数(1–20)', 1, 20, '8')
      case 'links':
        return optLabel(
          '一行一条,格式「名称|链接」(仅支持 http(s) 与站内 / 开头的路径)',
          <textarea
            value={w.options.items || ''}
            onChange={(e) => setOpt(w, 'items', e.target.value)}
            rows={4}
            placeholder={'Cloudflare|https://www.cloudflare.com\n我的另一个站|https://example.com'}
            className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400 resize-y font-mono"
          />
        )
      case 'tags':
        return <p className="text-[11px] text-gray-400">自动统计全部公开文章的笔记本与标签(取前 30),点击跳到按该标签筛选的列表,无需配置。</p>
      case 'search':
        return (
          <>
            {optText(w, 'placeholder', '输入框提示文字', '搜索文章…')}
            <p className="text-[11px] text-gray-400">搜索标题与正文,结果页地址形如 /blog?q=关键词。</p>
          </>
        )
      case 'slider':
        return (
          <>
            {optSelect(w, 'source', '取数来源', [['recent', '最新发布'], ['hot', '浏览量最高'], ['tag', '某个标签']], 'recent')}
            {(w.options.source || 'recent') === 'tag' && optText(w, 'tag', '标签名或笔记本名', '运维')}
            {optNumber(w, 'count', '张数(1–8)', 1, 8, '5')}
            {optSelect(w, 'height', '高度', [['sm', '矮'], ['md', '中'], ['lg', '高']], 'md')}
            {optCheck(w, 'auto', '自动播放', '1')}
            {(w.options.auto ?? '1') === '1' && optNumber(w, 'interval', '间隔(秒,2–30)', 2, 30, '5')}
            <p className="text-[11px] text-gray-400">只渲染当前及左右各一张,其余不会提前下载;首图优先加载。</p>
          </>
        )
      case 'banner':
        return (
          <>
            {optText(w, 'heading', '大标题', '欢迎来到我的博客')}
            {optText(w, 'subtitle', '副标题', '这里是我的公开笔记精选。')}
            {optText(w, 'bg', '背景(图片 URL 或颜色如 #1f6feb;留空用主题色渐变)')}
            {optText(w, 'btnText', '按钮文字(留空则不显示按钮)')}
            {optText(w, 'btnUrl', '按钮链接(http(s):// 或站内 /)')}
            {optSelect(w, 'height', '高度', [['sm', '矮(当公告条用)'], ['md', '中'], ['lg', '高']], 'md')}
            {optCheck(w, 'dismissible', '访客可关闭(记在浏览器里;改了文案会重新出现)', '0')}
          </>
        )
      case 'related':
        return (
          <>
            {optNumber(w, 'count', '篇数(1–8)', 1, 8, '4')}
            {optSelect(w, 'cols', '每行列数', [['2', '2 列'], ['3', '3 列'], ['4', '4 列']], '4')}
            <p className="text-[11px] text-gray-400">按「同笔记本 +2 分、每个共同标签 +3 分」排序取前几篇。</p>
          </>
        )
      case 'postgrid':
        return (
          <>
            {optSelect(w, 'source', '取数来源', [['recent', '最新发布'], ['hot', '浏览量最高'], ['tag', '某个标签']], 'recent')}
            {(w.options.source || 'recent') === 'tag' && optText(w, 'tag', '标签名或笔记本名', '运维')}
            {optNumber(w, 'count', '篇数(1–12)', 1, 12, '6')}
            {optSelect(w, 'cols', '每行列数', [['2', '2 列'], ['3', '3 列'], ['4', '4 列']], '3')}
          </>
        )
      case 'prevnext':
        return <p className="text-[11px] text-gray-400">按发布时间取相邻两篇,「上一篇」是更新的那篇(与列表顺序一致),无需配置。</p>
      default:
        return null
    }
  }

  // ---- 主题外观(P12.5)----
  const colorRow = (label: string, value: string, onChange: (v: string) => void, extra?: React.ReactNode) => (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-20 shrink-0">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-8 rounded border border-gray-200 bg-white cursor-pointer shrink-0"
        aria-label={label}
      />
      <input
        value={value}
        onChange={(e) => onChange(normalizeHex(e.target.value, value))}
        className="w-24 text-sm font-mono border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
      />
      {extra}
    </div>
  )
  const sliderRow = (label: string, value: number, min: number, max: number, unit: string, onChange: (v: number) => void) => (
    <label className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-20 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 min-w-0 max-w-[16rem] accent-emerald-500"
      />
      <span className="text-xs text-gray-400 tabular-nums w-14">{value}{unit}</span>
    </label>
  )

  const skinEditor = (s: BlogSkin) => {
    const active = matchPreset(s)
    return (
      <div className="max-w-3xl space-y-5">
        <div>
          <p className="text-xs font-medium text-gray-600 mb-1.5">预设</p>
          <div className="flex flex-wrap gap-2">
            {SKIN_PRESETS.map((p) => (
              <button
                key={p.id}
                onClick={() => editSkin((x) => applyPreset(x, p.id))}
                className={`flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border transition-colors ${
                  active === p.id ? 'border-emerald-400 bg-emerald-50 text-emerald-700' : 'border-gray-200 text-gray-600 hover:border-emerald-300'
                }`}
              >
                <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: p.accent }} />
                <span className="w-3.5 h-3.5 rounded-full shrink-0 border border-gray-200" style={{ background: p.chrome }} />
                {p.name}
              </button>
            ))}
            {active === 'custom' && <span className="text-[11px] text-gray-400 self-center">当前为自定义配色</span>}
          </div>
          <p className="text-[11px] text-gray-400 mt-1.5">
            预设只改主色与顶栏色——中性色(卡片/边框/正文灰)是成对调过的明暗值,单独改容易配出读不了的组合;要精细控制用下面的「额外 CSS」。
          </p>
        </div>

        {/* 主题库(P12.7):内置预设只是「一键改两个颜色」,调顺手的整套配置此前没地方存 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs font-medium text-gray-600">我的主题</p>
            <label className="text-[11px] text-emerald-600 hover:text-emerald-700 cursor-pointer">
              导入主题文件…
              <input
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  e.target.value = '' // 允许连续导入同一个文件
                  if (f) importTheme(f)
                }}
              />
            </label>
          </div>

          {library.length === 0 && (
            <p className="text-[11px] text-gray-400">
              还没存过主题。把下面的配色与排版调顺手之后存一套下来,以后一键切回;也可以存多套换着看。
            </p>
          )}

          <ul className="space-y-1">
            {library.map((t) => (
              <li key={t.id} className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white">
                <span className="w-3.5 h-3.5 rounded-full shrink-0" style={{ background: t.skin.accent }} />
                <span className="w-3.5 h-3.5 rounded-full shrink-0 border border-gray-200" style={{ background: t.skin.chrome }} />
                <input
                  value={t.name}
                  maxLength={MAX_THEME_NAME}
                  onChange={(e) =>
                    // 打字时不去重,否则输到与已有主题同名的那一刻就会被自动加序号
                    editLibrary((l) => l.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))
                  }
                  onBlur={() => editLibrary((l) => renameTheme(l, t.id, t.name))}
                  className="flex-1 min-w-0 text-sm border border-transparent hover:border-gray-200 focus:border-emerald-400 rounded px-1.5 py-0.5 outline-none"
                />
                <button
                  onClick={() => { setSkin(t.skin); setDirty(true); flashTheme(`已套用「${t.name}」`) }}
                  className="text-xs text-gray-500 hover:text-emerald-600 shrink-0"
                  title="把这套主题设为当前生效的配置"
                >
                  套用
                </button>
                <button
                  onClick={() => { editLibrary((l) => updateTheme(l, t.id, skin)); flashTheme(`已把当前配置写回「${t.name}」`) }}
                  className="text-xs text-gray-500 hover:text-emerald-600 shrink-0"
                  title="用当前正在编辑的配置覆盖这套主题"
                >
                  更新
                </button>
                <button onClick={() => downloadTheme(t)} className="text-xs text-gray-500 hover:text-emerald-600 shrink-0" title="导出为 JSON 文件">
                  导出
                </button>
                <button
                  onClick={() => editLibrary((l) => removeTheme(l, t.id))}
                  className="text-xs text-gray-400 hover:text-red-500 shrink-0"
                  title="从主题库删除(不影响当前生效的配置)"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="flex items-center gap-2 mt-2">
            <input
              value={newThemeName}
              onChange={(e) => setNewThemeName(e.target.value)}
              placeholder="新主题名称"
              maxLength={MAX_THEME_NAME}
              className="w-40 text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
            />
            <button
              onClick={saveCurrentAsTheme}
              className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:border-emerald-300 hover:text-emerald-700"
            >
              保存当前配置为主题
            </button>
          </div>

          {themeMsg && <p className="text-[11px] text-emerald-600 mt-1.5">{themeMsg}</p>}

          <p className="text-[11px] text-gray-400 mt-1.5">
            主题库只存在管理端(`settings.blog_skin_library`),博客页一行都不读它——存多少套都不影响访客的加载。
            导出的是一份配置 JSON(配色 / 排版 / 额外 CSS),不是 WordPress 那种含模板的主题包。
            导入他人的主题时会剥掉额外 CSS 里的 `@import` 并把外部地址列出来:CSS 不能执行 JS,但能把访客的 IP 与来源发给第三方。
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">配色</p>
          {colorRow('主色', s.accent, (v) => editSkin((x) => ({ ...x, accent: v, preset: 'custom' })))}
          {colorRow(
            '悬浮色',
            s.accentHover || hoverColor(s),
            (v) => editSkin((x) => ({ ...x, accentHover: v, preset: 'custom' })),
            <label className="flex items-center gap-1 text-[11px] text-gray-500">
              <input
                type="checkbox"
                checked={s.accentHover === ''}
                onChange={(e) => editSkin((x) => ({ ...x, accentHover: e.target.checked ? '' : hoverColor(x) }))}
                className="accent-emerald-500"
              />
              跟随主色自动提亮
            </label>
          )}
          {colorRow('顶栏/页脚', s.chrome, (v) => editSkin((x) => ({ ...x, chrome: v, preset: 'custom' })))}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">排版</p>
          {sliderRow('圆角', s.radius, MIN_RADIUS, MAX_RADIUS, 'px', (v) => editSkin((x) => ({ ...x, radius: v })))}
          {sliderRow('正文字号', s.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE, 'px', (v) => editSkin((x) => ({ ...x, fontSize: v })))}
          {sliderRow('容器宽度', s.width, MIN_WIDTH, MAX_WIDTH, 'px', (v) => editSkin((x) => ({ ...x, width: v })))}
          <p className={`text-[11px] ml-[5.5rem] ${tooNarrow ? 'text-amber-600' : 'text-gray-400'}`}>
            按列表页当前侧栏计算,正文宽约 {width}px{tooNarrow ? ' · 偏窄,代码块和表格会难看' : ''}
          </p>
          <label className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-20 shrink-0">字体</span>
            <select
              value={s.font}
              onChange={(e) => editSkin((x) => ({ ...x, font: e.target.value as FontKey }))}
              className="text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
            >
              {(Object.keys(FONT_LABELS) as FontKey[]).map((f) => (<option key={f} value={f}>{FONT_LABELS[f]}</option>))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-20 shrink-0">列表样式</span>
            <select
              value={s.listStyle}
              onChange={(e) => editSkin((x) => ({ ...x, listStyle: e.target.value as ListStyle }))}
              className="text-sm border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
            >
              {(Object.keys(LIST_STYLE_LABELS) as ListStyle[]).map((v) => (<option key={v} value={v}>{LIST_STYLE_LABELS[v]}</option>))}
            </select>
          </label>
          <p className="text-[11px] text-gray-400 ml-[5.5rem]">纯文字列表不出缩略图,除了观感,也省掉每篇一次的图片请求。</p>
        </div>

        <div>
          <p className="text-xs font-medium text-gray-600 mb-1">额外 CSS</p>
          <textarea
            value={s.css}
            onChange={(e) => editSkin((x) => ({ ...x, css: e.target.value.slice(0, MAX_CSS_LEN) }))}
            rows={8}
            spellCheck={false}
            placeholder={'/* 只作用于博客页。可用选择器如: */\n.cfnote-blog .cfnote-preview h2 { border-left: 4px solid var(--blog-accent); padding-left: .5rem; }\n.dark.cfnote-blog { --blog-bg: #1a1a1a; }'}
            className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-emerald-400 resize-y font-mono"
          />
          <p className="text-[11px] text-gray-400 mt-1">
            {s.css.length}/{MAX_CSS_LEN} 字符 · 注入在博客页内,不影响笔记本界面。中性色不满意时改 <code className="font-mono">--blog-bg</code> / <code className="font-mono">--blog-card</code> 一类变量即可。
          </p>
        </div>
      </div>
    )
  }
  // ---- 文章块部件(P12.8)----
  // 详情页正文区此前是写死的:面包屑 → 标题 → 元信息 → 正文 → 「· 完 ·」→ 评论。
  // 成员固定、只能排序与开关——这样「详情页由这几块组成」是个恒定的心智模型,
  // 也省掉了「配置里没有正文怎么办」这类边界。存在 blog_layout.article 里,跟着布局一起下发。
  const editArticle = (fn: (parts: ArticlePart[]) => ArticlePart[]) =>
    edit((l) => ({ ...l, article: fn(l.article) }))

  const partOptionRows = (p: ArticlePart) => {
    const sub = (key: string, label: string) => (
      <label key={key} className="flex items-center gap-1 text-[11px] text-gray-500">
        <input
          type="checkbox"
          checked={partFlag(p, key)}
          onChange={(e) => editArticle((x) => setArticlePartOption(x, p.type, key, e.target.checked ? '1' : '0'))}
          className="accent-emerald-500"
        />
        {label}
      </label>
    )
    if (p.type === 'meta') {
      return (
        <div className="ml-6 mt-1.5 space-y-1.5">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {sub('time', '时间')}
            {sub('source', '来源')}
            {sub('tags', 'Tags')}
            {sub('views', '浏览数')}
          </div>
          {partFlag(p, 'source') && (
            <input
              value={p.options.sourceText ?? DEFAULT_SOURCE_TEXT}
              onChange={(e) => editArticle((x) => setArticlePartOption(x, p.type, 'sourceText', e.target.value))}
              placeholder={DEFAULT_SOURCE_TEXT}
              className="w-full text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
            />
          )}
        </div>
      )
    }
    if (p.type === 'divider') {
      return (
        <input
          value={p.options.text ?? DEFAULT_DIVIDER_TEXT}
          onChange={(e) => editArticle((x) => setArticlePartOption(x, p.type, 'text', e.target.value))}
          placeholder={DEFAULT_DIVIDER_TEXT}
          className="ml-6 mt-1.5 w-40 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400"
        />
      )
    }
    if (p.type === 'copyright') {
      return (
        <textarea
          value={p.options.text ?? ''}
          onChange={(e) => editArticle((x) => setArticlePartOption(x, p.type, 'text', e.target.value))}
          rows={3}
          maxLength={MAX_PART_TEXT}
          placeholder="本文采用 [CC BY-NC-SA 4.0](https://example.com) 许可协议，转载请注明出处。"
          className="ml-6 mt-1.5 w-[calc(100%-1.5rem)] text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-emerald-400 font-mono"
        />
      )
    }
    return null
  }

  const articleEditor = (l: BlogLayout) => (
    <div className="border border-gray-100 rounded-lg p-2">
      <div className="px-1 pb-2">
        <span className="text-xs font-medium text-gray-600">文章块<span className="text-[11px] text-gray-400 ml-1">(正文区,只在详情页)</span></span>
        <p className="text-[11px] text-gray-400 mt-1">
          可排序、可开关,但不能增删——这样「详情页由这几块组成」是恒定的。
          服务端预渲染照同一份配置产出 HTML,抓取器看到的顺序与读者一致。
        </p>
      </div>
      <ul className="space-y-1">
        {l.article.map((p, i) => (
          <li key={p.type} className="px-2 py-1.5 rounded-lg border border-gray-200 bg-white">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={p.enabled}
                disabled={isPartLocked(p.type)}
                onChange={(e) => editArticle((x) => toggleArticlePart(x, p.type, e.target.checked))}
                className="accent-emerald-500 disabled:opacity-40"
                title={isPartLocked(p.type) ? '该部件不可停用' : ''}
              />
              <span className={`text-sm flex-1 min-w-0 ${p.enabled ? 'text-gray-700' : 'text-gray-400'}`}>
                {ARTICLE_PART_LABELS[p.type]}
              </span>
              <button onClick={() => editArticle((x) => moveArticlePart(x, p.type, -1))} disabled={i === 0} className="text-xs text-gray-400 hover:text-emerald-600 disabled:opacity-30" title="上移">↑</button>
              <button onClick={() => editArticle((x) => moveArticlePart(x, p.type, 1))} disabled={i === l.article.length - 1} className="text-xs text-gray-400 hover:text-emerald-600 disabled:opacity-30" title="下移">↓</button>
            </div>
            <p className="text-[11px] text-gray-400 mt-0.5 ml-6">{ARTICLE_PART_HINTS[p.type]}</p>
            {p.enabled && partOptionRows(p)}
          </li>
        ))}
      </ul>
    </div>
  )

  const menuEditor = (l: BlogLayout) => (    <div className="max-w-3xl space-y-2">
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
      id={`wrow-${w.id}`}
      draggable
      onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = 'move' }}
      onDragEnd={() => { setDragId(null); setOverSlot(null) }}
      onDragOver={(e) => { if (dragId) { e.preventDefault(); e.stopPropagation(); setOverSlot(slot) } }}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); drop(slot, i) }}
      className={`px-3 py-2 rounded-lg border cursor-move transition-opacity ${
        dragId === w.id ? 'opacity-40' : ''
      } ${editing === w.id ? 'border-emerald-400 ring-1 ring-emerald-200' : w.enabled ? 'border-gray-200 bg-white' : 'border-dashed border-gray-200 bg-gray-50'}`}
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

      {/* 配置从别处搬过来/换过页面时可能出现「这个模块在本页没意义」 */}
      {!widgetWorksOn(w.type, page) && (
        <p className="text-[11px] text-amber-600 mt-1">该模块要有「当前文章」才成立,只在详情页显示。</p>
      )}

      {editing === w.id && (
        <div className="mt-2 space-y-2 border-t border-gray-100 pt-2">
          {optLabel('标题(留空则不显示标题栏)', (
            <input
              value={w.title}
              onChange={(e) => edit((l) => updateWidget(l, page, w.id, { title: e.target.value }))}
              placeholder={w.type === 'hot' ? '热榜自带日/周/月切换,通常留空' : ''}
              className="w-full text-sm border border-gray-200 rounded-lg px-2 py-1 mt-0.5 outline-none focus:border-emerald-400"
            />
          ))}

          {widgetOptions(w)}

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
        <button onClick={() => { setTab('skin'); setEditing(null) }} className={`text-xs px-2.5 py-1 rounded-lg ${tab === 'skin' ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
          主题外观
        </button>

        {cur && tab !== 'menu' && tab !== 'skin' && (
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

      <div className="flex-1 flex min-h-0">
        <div className={`overflow-y-auto p-3 ${tab === 'menu' ? 'flex-1' : 'w-full lg:w-[27rem] lg:shrink-0'}`}>
          {!cur || !layout ? (
            <div className="py-20 flex justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
          ) : tab === 'menu' ? (
            menuEditor(layout)
          ) : tab === 'skin' ? (
            skinEditor(skin)
          ) : (
            <div className="space-y-3">
              {tab === 'detail' && articleEditor(layout)}
              {SLOTS.map((s) => {
                const side = s === 'left' || s === 'right'
                const choices = widgetChoices(s, page)
                return (
                  <div
                    key={s}
                    onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverSlot(s) } }}
                    onDragLeave={() => setOverSlot((cs) => (cs === s ? null : cs))}
                    onDrop={(e) => { e.preventDefault(); drop(s, null) }}
                    className={`border rounded-lg p-2 flex flex-col min-h-[92px] transition-colors ${
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
                        onChange={(e) => { if (e.target.value) edit((l) => addWidget(l, page, s, e.target.value as WidgetType)) }}
                        className="text-[11px] border border-gray-200 rounded px-1 py-0.5 text-gray-500 outline-none focus:border-emerald-400"
                      >
                        <option value="">+ 添加</option>
                        {/* 按槽位分「常用 / 其他」两组:不硬性禁止乱放(宽度都是自适应的),只给个次序 */}
                        <optgroup label="本槽位常用">
                          {choices.common.map((t) => (<option key={t} value={t}>{WIDGET_LABELS[t]}</option>))}
                        </optgroup>
                        {choices.others.length > 0 && (
                          <optgroup label="其他">
                            {choices.others.map((t) => (<option key={t} value={t}>{WIDGET_LABELS[t]}</option>))}
                          </optgroup>
                        )}
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
                      <div className="flex-1 flex items-center justify-center text-[11px] text-gray-300 py-2">拖模块到这里</div>
                    ) : (
                      <ul className="space-y-1.5">{cur[s].map((w, i) => widgetRow(w, s, i, cur[s].length))}</ul>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 右侧是真的博客页(iframe);管理端窗口太窄时收起,左边照常能配。
            菜单页签不显示预览:菜单在顶栏,缩放后基本看不清,不如把编辑区放宽 */}
        {tab !== 'menu' && layout && (
          <div className="hidden lg:flex flex-1 min-w-0">
            <BlogPreview layout={layout} skin={skin} page={page} onSelect={selectWidget} />
          </div>
        )}
      </div>
    </div>
  )
}
