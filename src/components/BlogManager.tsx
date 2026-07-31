import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import ArticleEditor from './ArticleEditor'
import BlogLayoutPanel from './BlogLayoutPanel'
import { commentAvatar } from '../lib/comments'
import type { Notebook, Article } from '../types'

// 博客管理(P11.1 + P11.2;P11.4 内联;P11.7 两栏可编辑):占据侧栏右侧整个工作区。
// 「已公开文章」= 左列表(按修改时间降序 + 标题搜索/笔记本过滤)+ 右侧完整编辑器(源码/富文本/预览,复用 ArticleEditor);
// 「评论」为侧栏二级菜单进入的同级子视图(由 URL ?panel=blog|comments 驱动)。评论正文纯文本展示。

interface PublishedArticle {
  id: number
  notebook_id: number
  notebook: string | null
  title: string
  summary: string
  published_at: string | null
  updated_at: string
  views: number
  /** 单页(P13.4):不进列表/热榜/RSS,走单页布局 */
  is_page?: number
}

interface AdminComment {
  id: number
  article_id: number
  parent_id: number | null
  root_id: number | null
  author_name: string
  author_email: string | null
  content: string
  status: 'pending' | 'approved' | 'rejected'
  is_admin: number | boolean
  created_at: string
  article_title: string
  /** 来源(P11.9,仅管理端可见):明文 IP 与原始 UA;老评论为空 */
  ip: string | null
  user_agent: string | null
}

interface Props {
  token: string
  notebooks: Notebook[]
  /** 当前子视图,由 URL(?panel=blog|comments|layout)驱动 */
  tab: 'articles' | 'comments' | 'layout'
  onTabChange: (tab: 'articles' | 'comments' | 'layout') => void
  /** 返回笔记工作区 */
  onClose: () => void
  onOpenArticle: (id: number) => void
}

// 时间戳(UTC 无时区)补 Z 归一后本地展示
function fmtTime(s: string | null): string {
  if (!s) return '—'
  const iso = /[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return s
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export default function BlogManager({ token, notebooks, tab, onTabChange, onClose, onOpenArticle }: Props) {
  const api = useApi(token)
  const [pendingCount, setPendingCount] = useState(0)

  // ---- 文章 tab ----
  const [q, setQ] = useState('')
  const [nbFilter, setNbFilter] = useState(0)
  // 文章 / 单页(P13.4)。对标 WordPress 的「文章」与「页面」两个平行菜单,
  // 但不开二级菜单——它们共用同一个列表 + 同一个编辑器,只是筛选条件不同。
  const [kind, setKind] = useState<'all' | 'post' | 'page'>('all')
  const [items, setItems] = useState<PublishedArticle[] | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  // 选中并内联编辑(P11.7):列表点选 → 取全文 → 右侧 ArticleEditor
  const [selected, setSelected] = useState<Article | null>(null)
  const [loadingArticle, setLoadingArticle] = useState(false)
  const [listWidth, setListWidth] = useState(() => {
    const v = Number(localStorage.getItem('cfnote-blog-list-w'))
    return Number.isFinite(v) && v >= 240 && v <= 640 ? v : 320
  })
  const [listDragging, setListDragging] = useState(false)

  const loadArticles = useCallback(async () => {
    const params = new URLSearchParams()
    if (q.trim()) params.set('q', q.trim())
    if (nbFilter) params.set('notebook_id', String(nbFilter))
    if (kind !== 'all') params.set('kind', kind)
    const res = await api.get<PublishedArticle[]>(`/articles/published?${params.toString()}`)
    setItems(res.ok && res.data ? res.data : [])
  }, [api, q, nbFilter, kind])

  /**
   * 设为 / 取消单页(P13.4)。放在博客管理而不是 ArticleEditor 顶栏:
   * 「是不是单页」是博客呈现层的概念,不该跑到笔记工作区的编辑器里去。
   * 与公开状态正交——只改「是否进文章流」,不动 is_public。
   */
  const toggleIsPage = async (a: PublishedArticle) => {
    setBusyId(a.id)
    const next = a.is_page ? 0 : 1
    const res = await api.put<Article>(`/articles/${a.id}`, { is_page: next })
    setBusyId(null)
    if (!res.ok) return
    setItems((cur) => {
      const list = (cur || []).map((x) => (x.id === a.id ? { ...x, is_page: next } : x))
      // 正在按类型筛选时,改完就不属于当前筛选了 → 从列表里移除,免得留着一条对不上的行
      return kind === 'all' ? list : list.filter((x) => (kind === 'page' ? x.is_page : !x.is_page))
    })
  }

  // 打开某篇(P13.1):**立即**用列表行(标题 + 摘要)切换显示,正文异步补全。
  // 此前是 await 完 /articles/:id 才 setSelected,于是点了 B、右边还杵着 A 转圈,
  // 直到请求回来才换——笔记工作区(Layout.openArticle)早就改成乐观切换了,这里漏改。
  // 列表行的形态只有一种(PublishedArticle,带 summary),不存在「不同调用方字段不一致」的问题。
  const openInEditor = async (id: number) => {
    if (selected?.id === id) return
    const row = (items || []).find((a) => a.id === id)
    if (row) {
      setSelected({
        id: row.id, notebook_id: row.notebook_id, title: row.title,
        content: row.summary || '', tags: [],
        is_public: 1, is_private: 0,
        created_at: row.updated_at, updated_at: row.updated_at,
      } as unknown as Article)
    }
    setLoadingArticle(true)
    const res = await api.get<Article>(`/articles/${id}`)
    // 期间又点了别的条目就丢弃这次结果,否则慢请求会把新选中的覆盖回去
    if (res.ok && res.data) setSelected((cur) => (cur && cur.id !== id ? cur : res.data!))
    setLoadingArticle(false)
  }

  // 保存:走与主工作区同一个端点。保存后只就地更新该行,**不重排列表**——
  // 列表按 updated_at 降序,立即重排会让正在编辑的条目从脚下跳走。
  const saveArticle = async (id: number, data: { title?: string; content?: string; is_public?: number; is_private?: number; tags?: string[] }) => {
    const res = await api.put<Article>(`/articles/${id}`, data)
    if (res.ok) {
      const stillPublic = res.data ? res.data.is_public === 1 && res.data.is_private === 0 : true
      if (!stillPublic) {
        // 在编辑器里取消公开/设为私有 → 已不属于「已公开」集合
        setItems((cur) => (cur || []).filter((a) => a.id !== id))
        setSelected(null)
      } else {
        setItems((cur) => (cur || []).map((a) => (
          a.id === id ? { ...a, title: res.data?.title ?? a.title, updated_at: res.data?.updated_at ?? a.updated_at } : a
        )))
        if (res.data) setSelected((cur) => (cur && cur.id === id ? { ...cur, ...res.data } : cur))
      }
    }
    return res
  }

  // 拖拽调整列表宽度(照搬 Layout 的写法)
  const startListResize = (e: React.MouseEvent) => {
    e.preventDefault()
    setListDragging(true)
    const startX = e.clientX
    const startW = listWidth
    const onMove = (ev: MouseEvent) => setListWidth(Math.min(640, Math.max(240, startW + (ev.clientX - startX))))
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setListDragging(false)
      setListWidth((w) => { localStorage.setItem('cfnote-blog-list-w', String(w)); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---- 评论 tab ----
  const [cStatus, setCStatus] = useState<'pending' | 'all'>('pending')
  const [comments, setComments] = useState<AdminComment[] | null>(null)
  const [cBusy, setCBusy] = useState<number | null>(null)
  const [replyId, setReplyId] = useState<number | null>(null)
  const [replyText, setReplyText] = useState('')

  const loadComments = useCallback(async () => {
    const res = await api.get<AdminComment[]>(`/comments?status=${cStatus}`)
    setComments(res.ok && res.data ? res.data : [])
  }, [api, cStatus])

  const loadCounts = useCallback(async () => {
    const res = await api.get<{ pending: number; total: number }>('/comments/counts')
    if (res.ok && res.data) setPendingCount(res.data.pending)
  }, [api])

  useEffect(() => { loadCounts() }, [loadCounts])
  useEffect(() => {
    if (tab !== 'articles') return
    const t = setTimeout(loadArticles, 300)
    return () => clearTimeout(t)
  }, [loadArticles, tab])
  useEffect(() => { if (tab === 'comments') loadComments() }, [loadComments, tab])

  const unpublish = async (id: number) => {
    setBusyId(id)
    const res = await api.put(`/articles/${id}`, { is_public: 0 })
    if (res.ok) {
      setItems((cur) => (cur || []).filter((a) => a.id !== id))
      setSelected((cur) => (cur && cur.id === id ? null : cur)) // 取消公开的正是当前编辑项 → 清空右栏
    }
    setBusyId(null)
  }
  const openInApp = (id: number) => { onOpenArticle(id); onClose() }

  const setStatus = async (id: number, action: 'approve' | 'reject') => {
    setCBusy(id)
    await api.post(`/comments/${id}/${action}`, {})
    await Promise.all([loadComments(), loadCounts()])
    setCBusy(null)
  }
  const removeComment = async (id: number) => {
    setCBusy(id)
    await api.del(`/comments/${id}`)
    await Promise.all([loadComments(), loadCounts()])
    setCBusy(null)
  }
  const sendReply = async (id: number) => {
    if (!replyText.trim()) return
    setCBusy(id)
    const res = await api.post(`/comments/${id}/reply`, { content: replyText.trim() })
    if (res.ok) { setReplyId(null); setReplyText(''); await Promise.all([loadComments(), loadCounts()]) }
    setCBusy(null)
  }

  const tabCls = (active: boolean) =>
    `px-3 py-2 text-sm -mb-px border-b-2 transition-colors ${active ? 'border-emerald-500 text-emerald-700 font-medium' : 'border-transparent text-gray-500 hover:text-gray-700'}`
  const statusBadge = (s: AdminComment['status']) => {
    const m = { pending: 'bg-amber-100 text-amber-700', approved: 'bg-emerald-100 text-emerald-700', rejected: 'bg-gray-200 text-gray-500' }
    const label = { pending: '待审', approved: '已通过', rejected: '已拒绝' }
    return <span className={`text-[10px] px-1.5 py-0.5 rounded ${m[s]}`}>{label[s]}</span>
  }

  return (
    <div className="h-full flex flex-col bg-white overflow-hidden">
      {/* 顶栏 */}
      <div className="px-4 pt-4 flex items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-emerald-500 text-white flex items-center justify-center shrink-0">📢</span>
          <span className="font-semibold text-gray-900">博客管理</span>
          <span className="text-xs text-gray-400 truncate">{tab === 'articles' ? '已公开文章' : tab === 'comments' ? '评论审核' : '页面布局'}</span>
        </div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-emerald-600 shrink-0 px-2 py-1 rounded-lg hover:bg-gray-100" title="返回笔记工作区">
          返回笔记
        </button>
      </div>

      {/* 子视图切换(与侧栏二级菜单同源,点击即改 URL) */}
      <div className="px-4 border-b border-gray-100 flex items-center gap-1 shrink-0">
        <button onClick={() => onTabChange('articles')} className={tabCls(tab === 'articles')}>已公开文章{tab === 'articles' && items ? ` (${items.length})` : ''}</button>
        <button onClick={() => onTabChange('comments')} className={tabCls(tab === 'comments')}>
          评论管理
          {pendingCount > 0 && <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-red-500 text-white">{pendingCount > 99 ? '99+' : pendingCount}</span>}
        </button>
        <button onClick={() => onTabChange('layout')} className={tabCls(tab === 'layout')}>页面布局</button>
      </div>

        {tab === 'layout' ? (
          <BlogLayoutPanel token={token} />
        ) : tab === 'articles' ? (
          // 两栏(P11.7):左「已公开文章」列表 + 右完整编辑器,中间可拖拽分隔
          <div className="flex-1 flex min-h-0">
            <div className="flex flex-col min-h-0 shrink-0 border-r border-gray-100" style={{ width: listWidth }}>
              <div className="px-3 py-3 border-b border-gray-100 flex flex-col gap-2 shrink-0">
                <div className="flex items-center gap-2">
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题…" className="flex-1 min-w-0 text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400" />
                  <select value={nbFilter} onChange={(e) => setNbFilter(Number(e.target.value))} className="shrink-0 text-sm border border-gray-200 rounded-lg px-2 py-1.5 bg-white text-gray-700 outline-none focus:border-emerald-400 max-w-[120px]">
                    <option value={0}>全部笔记本</option>
                    {notebooks.map((n) => (<option key={n.id} value={n.id}>{n.name}</option>))}
                  </select>
                </div>
                {/* 文章 / 单页(P13.4):单页仍然公开可访问,只是不进列表、热榜与 RSS */}
                <div className="flex items-center gap-1">
                  {([['all', '全部'], ['post', '文章'], ['page', '单页']] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setKind(v)}
                      className={`text-xs px-2 py-0.5 rounded-md transition-colors ${
                        kind === v ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex-1 overflow-y-auto p-2">
                {items === null ? (
                  <div className="py-20 flex justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
                ) : items.length === 0 ? (
                  <div className="py-20 px-4 text-center text-sm text-gray-400">
                    {kind === 'page' && !q && !nbFilter
                      ? '还没有单页。把一篇已公开的笔记(比如「关于我」)设为单页,它就不再出现在文章列表里,但仍可通过菜单或链接访问。'
                      : q || nbFilter || kind !== 'all'
                        ? '没有匹配的已公开文章'
                        : '还没有公开任何文章。在编辑器里点「公开」即可发布到博客。'}
                  </div>
                ) : (
                  <ul className="space-y-1">
                    {items.map((a) => {
                      const active = selected?.id === a.id
                      return (
                        <li
                          key={a.id}
                          onClick={() => openInEditor(a.id)}
                          className={`group cursor-pointer px-3 py-2 rounded-lg border transition-colors ${active ? 'bg-emerald-50 border-emerald-200' : 'border-transparent hover:bg-gray-50 hover:border-gray-100'}`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className={`text-sm font-medium truncate ${active ? 'text-emerald-800' : 'text-gray-800'}`}>
                                {a.is_page ? (
                                  <span className="text-[10px] px-1 py-0.5 rounded bg-sky-50 text-sky-600 mr-1.5 align-middle" title="单页:公开可访问,但不进列表/热榜/RSS">单页</span>
                                ) : null}
                                {a.title || '无标题'}
                              </div>
                              <div className="text-[11px] text-gray-400 flex items-center gap-1.5 mt-0.5">
                                <span className="truncate max-w-[100px]">{a.notebook || '—'}</span>
                                <span className="shrink-0" title={`发布于 ${fmtTime(a.published_at)}`}>· {fmtTime(a.updated_at)}</span>
                                <span className="shrink-0">· {a.views} 浏览</span>
                              </div>
                            </div>
                            {/* 悬浮才出:预览↗ / 设为单页 / 取消公开(阻止冒泡,避免顺带切换选中) */}
                            <div className="flex items-center gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                              <a href={`/blog/${a.id}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-[11px] text-gray-400 hover:text-emerald-600" title="在新标签预览博客页">预览↗</a>
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleIsPage(a) }}
                                disabled={busyId === a.id}
                                className="text-[11px] text-gray-400 hover:text-sky-600 disabled:opacity-50"
                                title={a.is_page ? '改回普通文章(重新进入列表与 RSS)' : '设为单页:仍可通过链接访问,但不出现在列表、热榜与 RSS 里'}
                              >
                                {a.is_page ? '改回文章' : '设为单页'}
                              </button>
                              <button onClick={(e) => { e.stopPropagation(); unpublish(a.id) }} disabled={busyId === a.id} className="text-[11px] text-gray-400 hover:text-red-500 disabled:opacity-50" title="从博客撤下(设为不公开)">
                                {busyId === a.id ? '…' : '取消公开'}
                              </button>
                            </div>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>

            {/* 拖拽分隔条(宽度存 localStorage) */}
            <div
              onMouseDown={startListResize}
              className={`w-1 shrink-0 cursor-col-resize transition-colors ${listDragging ? 'bg-emerald-300' : 'bg-transparent hover:bg-emerald-200'}`}
              title="拖动调整列表宽度"
            />

            <div className="flex-1 min-w-0 min-h-0">
              {selected ? (
                <ArticleEditor
                  key={selected.id}
                  article={selected}
                  token={token}
                  onSave={saveArticle}
                  loadingContent={loadingArticle}
                  onOpenArticle={openInApp}
                />
              ) : loadingArticle ? (
                <div className="h-full flex justify-center items-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-6">
                  <div className="text-4xl">📝</div>
                  <div className="text-sm text-gray-400">从左侧选择一篇已公开文章开始编辑</div>
                  <div className="text-xs text-gray-300">源码 / 富文本 / 预览三种模式,保存后博客页同步更新</div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2 shrink-0">
              {(['pending', 'all'] as const).map((s) => (
                <button key={s} onClick={() => setCStatus(s)} className={`text-xs px-2.5 py-1 rounded-lg ${cStatus === s ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`}>
                  {s === 'pending' ? '待审核' : '全部'}
                </button>
              ))}
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              {comments === null ? (
                <div className="py-20 flex justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>
              ) : comments.length === 0 ? (
                <div className="py-20 text-center text-sm text-gray-400">{cStatus === 'pending' ? '没有待审核的评论' : '还没有评论'}</div>
              ) : (
                <ul className="space-y-2">
                  {comments.map((cm) => {
                    const av = commentAvatar(cm.author_name)
                    return (
                    <li
                      key={cm.id}
                      className={`px-3 py-2.5 rounded-lg border transition-colors ${
                        replyId === cm.id
                          ? 'bg-emerald-50/60 border-emerald-200'
                          : 'border-gray-100 hover:bg-gray-50/70 hover:border-gray-200'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm flex-wrap">
                        {/* 头像占位:与博客页同一套取色(博主固定 emerald) */}
                        <span aria-hidden className="w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-white text-[10px] font-semibold select-none" style={{ backgroundColor: cm.is_admin ? '#10b981' : av.color }}>{av.char}</span>
                        <span className="font-medium text-gray-800">{cm.author_name}</span>
                        {cm.is_admin ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500 text-white">博主</span> : null}
                        {statusBadge(cm.status)}
                        {cm.parent_id && <span className="text-[11px] text-gray-400">回复</span>}
                        <span className="text-[11px] text-gray-400 ml-auto">{fmtTime(cm.created_at)}</span>
                      </div>
                      <div className="text-sm text-gray-700 mt-1 whitespace-pre-wrap break-words">{cm.content}</div>
                      <div className="text-[11px] text-gray-400 mt-1 truncate">
                        于《{cm.article_title || '无标题'}》{cm.author_email ? ` · ${cm.author_email}` : ''}
                      </div>
                      {/* 来源(P11.9):博主自己看,不对外;老评论没有这两列则整行不显示 */}
                      {(cm.ip || cm.user_agent) && (
                        <div className="text-[11px] text-gray-400 mt-0.5 flex items-center gap-2 min-w-0">
                          {cm.ip && <span className="font-mono shrink-0" title="提交时的来源 IP">{cm.ip}</span>}
                          {cm.user_agent && <span className="truncate" title={cm.user_agent}>{cm.user_agent}</span>}
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-2">
                        {cm.status !== 'approved' && <button onClick={() => setStatus(cm.id, 'approve')} disabled={cBusy === cm.id} className="text-xs text-emerald-600 hover:underline disabled:opacity-50">通过</button>}
                        {cm.status !== 'rejected' && <button onClick={() => setStatus(cm.id, 'reject')} disabled={cBusy === cm.id} className="text-xs text-gray-500 hover:underline disabled:opacity-50">{cm.status === 'approved' ? '下架' : '拒绝'}</button>}
                        <button onClick={() => { setReplyId(replyId === cm.id ? null : cm.id); setReplyText('') }} className="text-xs text-gray-500 hover:text-emerald-600">回复</button>
                        <a
                          href={`/blog/${cm.article_id}#comment-${cm.id}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-gray-400 hover:text-emerald-600"
                          title={cm.status === 'approved' ? '在博客页定位到这条评论' : '通过后才会出现在博客页(现在打开只会跳到文章)'}
                        >
                          查看↗
                        </a>
                        <button onClick={() => removeComment(cm.id)} disabled={cBusy === cm.id} className="text-xs text-gray-400 hover:text-red-500 ml-auto disabled:opacity-50">删除</button>
                      </div>
                      {replyId === cm.id && (
                        <div className="mt-2 flex items-start gap-2">
                          <textarea value={replyText} onChange={(e) => setReplyText(e.target.value)} rows={2} placeholder="以博主身份回复…" className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-emerald-400 resize-y" />
                          <button onClick={() => sendReply(cm.id)} disabled={cBusy === cm.id || !replyText.trim()} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 shrink-0">发送</button>
                        </div>
                      )}
                    </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </>
        )}
    </div>
  )
}
