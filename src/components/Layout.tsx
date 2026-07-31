import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { useApi } from '../hooks/useApi'
import Sidebar from './Sidebar'
import ArticleList from './ArticleList'
import ArticleEditor from './ArticleEditor'
import SearchPanel from './SearchPanel'
import StatsPanel from './StatsPanel'
import SettingsPanel from './SettingsPanel'
import SystemLogsPanel from './SystemLogsPanel'
import ImportDialog from './ImportDialog'
import AiChatPanel from './AiChatPanel'
import RemindersPanel from './RemindersPanel'
import { isDue, type ReminderItem } from '../lib/reminders'
import { PRIVATE_NOTEBOOK, TRASH_NOTEBOOK, TAG_VIEW_ID, tagNotebook } from '../types'
import type { Notebook, Article } from '../types'
import { parseLocation, buildLocation, isEmptyRoute, type MainRoute, type RouteView, type RoutePanel, type FmSub } from '../lib/route'
import { useFileManager, type FmView } from '../hooks/useFileManager'

// 文件管理页(P8.2,懒加载独立 chunk)
const FileManager = lazy(() => import('./FileManager'))
// 文件管理二级菜单(P11.6,懒加载):渲染进侧栏「文件管理」之下
const FileManagerNav = lazy(() => import('./FileManagerNav'))
// 博客管理页(P11.1,懒加载):管理已公开文章(+ 后续评论审核)
const BlogManager = lazy(() => import('./BlogManager'))

interface Props {
  token: string
  username: string
  onLogout: () => void
}

export default function Layout({ token, username, onLogout }: Props) {
  const { get, post, put, del } = useApi(token, onLogout)
  // 文件管理共享数据(P11.6):侧栏二级菜单与右侧文件列表同一份 overview / 文件夹操作
  const fm = useFileManager(token)
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [activeNotebook, setActiveNotebook] = useState<Notebook | null>(null)
  const [articles, setArticles] = useState<Article[]>([])
  const [activeArticle, setActiveArticle] = useState<Article | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  // 设置面板打开后要滚到哪一节(目前只有文件管理右上角的齿轮会用到)
  const [settingsFocus, setSettingsFocus] = useState<'files' | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  // 文件管理子视图(P11.6):与 URL 的 ?fm= 同步,侧栏二级菜单与右侧列表共用
  const [fmView, setFmView] = useState<FmView>({ kind: 'all' })
  // 博客管理(P11.4;P12.1 加「页面布局」):内联模块,null=不显示;
  // 三个子视图 'articles'/'comments'/'layout' 对应 ?panel=blog|comments|layout
  const [blogView, setBlogView] = useState<'articles' | 'comments' | 'layout' | null>(null)
  const [importing, setImporting] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('cfnote-sidebar-open') !== '0')
  const toggleSidebar = () =>
    setSidebarOpen((v) => {
      localStorage.setItem('cfnote-sidebar-open', v ? '0' : '1')
      return !v
    })
  const [showChat, setShowChat] = useState(() => localStorage.getItem('cfnote-chat-open') === '1')
  // AI 对话折叠状态存本地(不进 URL):与 chatWidth 同属布局偏好
  const setChatOpen = (v: boolean) => { setShowChat(v); localStorage.setItem('cfnote-chat-open', v ? '1' : '0') }
  const chatMaxWidth = () => Math.max(300, Math.floor(window.innerWidth / 2))
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cfnote-chat-width'))
    return saved >= 300 && saved <= chatMaxWidth() ? saved : 380
  })
  const [chatDragging, setChatDragging] = useState(false)
  // 文章列表宽度可拖拽:默认 288px(原 w-72),范围 220 ~ 576(原宽两倍),存 localStorage
  const [listWidth, setListWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cfnote-list-width'))
    return saved >= 220 && saved <= 576 ? saved : 288
  })
  const [listDragging, setListDragging] = useState(false)
  const [highlight, setHighlight] = useState<{ text: string; ts: number } | null>(null)
  const restoredRef = useRef(false)
  const didInitRef = useRef(false)          // URL 路由初始化只跑一次
  const applyingRef = useRef(false)         // 正在把 URL 套用到视图:期间抑制 state→URL 回写
  const urlTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  const toggleTheme = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('cfnote-theme', next ? 'dark' : 'light')
  }

  // 拖拽调整 AI 对话面板宽度(上限为屏幕一半)
  const startChatResize = (e: React.MouseEvent) => {
    e.preventDefault()
    setChatDragging(true)
    const startX = e.clientX
    const startW = chatWidth
    const max = chatMaxWidth()
    const onMove = (ev: MouseEvent) => {
      setChatWidth(Math.min(max, Math.max(300, startW + (startX - ev.clientX))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setChatDragging(false)
      setChatWidth((w) => { localStorage.setItem('cfnote-chat-width', String(w)); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 拖拽调整文章列表宽度(列表右缘,向右拖变宽)
  const startListResize = (e: React.MouseEvent) => {
    e.preventDefault()
    setListDragging(true)
    const startX = e.clientX
    const startW = listWidth
    const onMove = (ev: MouseEvent) => {
      setListWidth(Math.min(576, Math.max(220, startW + (ev.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setListDragging(false)
      setListWidth((w) => {
        localStorage.setItem('cfnote-list-width', String(w))
        return w
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 退出文件管理:子视图一并回到「全部文件」,下次进入不残留上次停在的文件夹
  const closeFiles = useCallback(() => { setShowFiles(false); setFmView({ kind: 'all' }) }, [])

  // 进入文件管理时加载共享 overview(侧栏二级菜单与右侧列表同一份;不进入则完全不拉)
  const reloadFmOverview = fm.reloadOverview
  useEffect(() => { if (showFiles) reloadFmOverview() }, [showFiles, reloadFmOverview])

  // 从 AI 对话/搜索打开文章:可携带引用片段用于定位高亮
  const openArticleWithSnippet = (id: number, snippet?: string) => {
    loadArticleDetail(id)
    if (snippet) setHighlight({ text: snippet, ts: Date.now() })
    // 打开文章即回到笔记工作区(否则被博客管理/文件管理内联模块挡住)
    setBlogView(null)
    closeFiles()
  }

  const loadNotebooks = useCallback(async () => {
    const res = await get<Notebook[]>('/notebooks')
    if (res.ok && res.data) setNotebooks(res.data)
  }, [get])

  useEffect(() => { loadNotebooks() }, [loadNotebooks])

  // P9 标签聚合(侧栏标签区;保存/删除/恢复后刷新)
  const [tags, setTags] = useState<{ name: string; count: number }[]>([])
  const loadTags = useCallback(async () => {
    const res = await get<{ name: string; count: number }[]>('/articles/tags')
    if (res.ok && res.data) setTags(res.data)
  }, [get])
  useEffect(() => { loadTags() }, [loadTags])

  // P10 提醒:顶栏铃铛列表(设了 remind_at 且未删除的笔记);打开面板与设置提醒后刷新,并每分钟轮询
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [showReminders, setShowReminders] = useState(false)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const loadReminders = useCallback(async () => {
    const res = await get<ReminderItem[]>('/articles/reminders')
    if (res.ok && res.data) setReminders(res.data)
  }, [get])
  useEffect(() => {
    loadReminders()
    const t = setInterval(() => { setNowTick(Date.now()); loadReminders() }, 60000)
    return () => clearInterval(t)
  }, [loadReminders])
  const dueCount = reminders.filter((r) => isDue(r.remind_at, nowTick)).length

  const loadArticles = useCallback(async (nb: Notebook) => {
    // 虚拟视图:我的私有 / 回收站 / 标签(name 即标签名);其余为真实笔记本
    const url =
      nb.id === PRIVATE_NOTEBOOK.id ? '/articles/private'
      : nb.id === TRASH_NOTEBOOK.id ? '/articles/trash'
      : nb.id === TAG_VIEW_ID ? `/articles/by-tag?tag=${encodeURIComponent(nb.name)}`
      : `/notebooks/${nb.id}/articles`
    const res = await get<Article[]>(url)
    if (res.ok && res.data) setArticles(res.data)
  }, [get])

  useEffect(() => {
    if (activeNotebook) {
      loadArticles(activeNotebook)
      setActiveArticle(null)
    } else {
      setArticles([])
      setActiveArticle(null)
    }
  }, [activeNotebook, loadArticles])

  const loadArticleDetail = useCallback(async (articleId: number) => {
    const res = await get<Article>(`/articles/${articleId}`)
    if (res.ok && res.data) setActiveArticle(res.data)
  }, [get])

  // 从列表选中文章:立即用列表项(标题+摘要)切换显示,正文异步补全,不阻塞界面
  const [articleLoading, setArticleLoading] = useState(false)
  const openArticle = (a: Article) => {
    if (activeArticle?.id === a.id) return
    setActiveArticle({ ...a, content: (a as any).summary ?? '' })
    setArticleLoading(true)
    loadArticleDetail(a.id).finally(() => setArticleLoading(false))
  }

  // URL → 视图:把解析出的路由套用到 state。与深链消费者同构——先设笔记本,
  //「切笔记本清空文章」副作用会清空选中,正文由 loadArticleDetail 异步落位。
  const applyRoute = useCallback((r: MainRoute) => {
    const v = r.view
    let nb: Notebook | null = null
    if (v.kind === 'notebook') nb = notebooks.find((n) => n.id === v.id) ?? null
    else if (v.kind === 'private') nb = PRIVATE_NOTEBOOK
    else if (v.kind === 'trash') nb = TRASH_NOTEBOOK
    else if (v.kind === 'tag') nb = tagNotebook(v.name)
    setActiveNotebook(nb)
    if (r.articleId) loadArticleDetail(r.articleId)
    else setActiveArticle(null)
    setShowFiles(r.panel === 'files')
    setFmView(r.fm ?? { kind: 'all' })
    setShowSettings(r.panel === 'settings')
    setShowStats(r.panel === 'stats')
    setShowLogs(r.panel === 'logs')
    setBlogView(r.panel === 'blog' ? 'articles' : r.panel === 'comments' ? 'comments' : r.panel === 'layout' ? 'layout' : null)
  }, [notebooks, loadArticleDetail])

  // 由当前 state 反推规范 URL(pathname+search)
  const currentTarget = useCallback((): string => {
    const view: RouteView =
      !activeNotebook ? { kind: 'none' }
      : activeNotebook.id === PRIVATE_NOTEBOOK.id ? { kind: 'private' }
      : activeNotebook.id === TRASH_NOTEBOOK.id ? { kind: 'trash' }
      : activeNotebook.id === TAG_VIEW_ID ? { kind: 'tag', name: activeNotebook.name }
      : { kind: 'notebook', id: activeNotebook.id }
    const panel: RoutePanel =
      blogView === 'articles' ? 'blog'
      : blogView === 'comments' ? 'comments'
      : blogView === 'layout' ? 'layout'
      : showFiles ? 'files' : showSettings ? 'settings' : showStats ? 'stats' : showLogs ? 'logs' : null
    const fm: FmSub | null = showFiles ? fmView : null
    return buildLocation({ view, articleId: activeArticle && activeArticle.id > 0 ? activeArticle.id : null, panel, fm })
  }, [activeNotebook, activeArticle, showFiles, showSettings, showStats, showLogs, blogView, fmView])

  // 首次加载完笔记本后:按 URL 恢复视图(兼容 /?article= 深链;裸根路径回退 localStorage)。
  // 全程置 applyingRef,落位到目标 URL 后由「视图→URL」effect 自动释放;2s 兜底防异步失败永久抑制。
  useEffect(() => {
    if (didInitRef.current || notebooks.length === 0) return
    didInitRef.current = true
    restoredRef.current = true
    applyingRef.current = true
    const safety = setTimeout(() => { applyingRef.current = false }, 2000)
    const route = parseLocation(window.location.pathname, window.location.search)

    // 1) 兼容深链 /?article=<id>:拉文章定位笔记本,规范化到 /nb/:nbId/:id
    if (route.legacyArticleId) {
      const id = route.legacyArticleId
      ;(async () => {
        const res = await get<Article>(`/articles/${id}`)
        if (!res.ok || !res.data) { window.history.replaceState(null, '', '/'); applyingRef.current = false; return }
        const nb = notebooks.find((n) => n.id === res.data!.notebook_id) ?? null
        if (nb) setActiveNotebook(nb)
        loadArticleDetail(id)
        window.history.replaceState(null, '', buildLocation({ view: nb ? { kind: 'notebook', id: nb.id } : { kind: 'none' }, articleId: id, panel: null }))
      })()
      return () => clearTimeout(safety)
    }

    // 2) URL 明确表达了视图 → 以 URL 为准
    if (!isEmptyRoute(route)) {
      applyRoute(route)
      return () => clearTimeout(safety)
    }

    // 3) 裸根路径 → 回退 localStorage(真实/私有/回收站可复原;标签视图未存名字,跳过),并规范化地址栏
    const lastId = Number(localStorage.getItem('cfnote-last-notebook'))
    const nb: Notebook | null =
      lastId === PRIVATE_NOTEBOOK.id ? PRIVATE_NOTEBOOK
      : lastId === TRASH_NOTEBOOK.id ? TRASH_NOTEBOOK
      : notebooks.find((n) => n.id === lastId) ?? null
    if (!nb) { applyingRef.current = false; return () => clearTimeout(safety) }
    setActiveNotebook(nb)
    const artId = Number(localStorage.getItem('cfnote-last-article'))
    const validArt = Number.isInteger(artId) && artId > 0 ? artId : null
    if (validArt) loadArticleDetail(validArt)
    window.history.replaceState(null, '', buildLocation({
      view: nb.id === PRIVATE_NOTEBOOK.id ? { kind: 'private' } : nb.id === TRASH_NOTEBOOK.id ? { kind: 'trash' } : { kind: 'notebook', id: nb.id },
      articleId: validArt, panel: null,
    }))
    return () => clearTimeout(safety)
  }, [notebooks, applyRoute, loadArticleDetail, get])

  // 浏览器前进/后退:重新解析 URL 套用到视图
  useEffect(() => {
    const onPop = () => {
      applyingRef.current = true
      setTimeout(() => { applyingRef.current = false }, 2000)
      applyRoute(parseLocation(window.location.pathname, window.location.search))
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [applyRoute])

  // 视图 → URL:去抖 20ms(把「选笔记本→清空文章」等同步级联并为一次 push),幂等等值比较防环。
  // applyingRef 期间不 push;一旦状态落位到目标 URL(target===cur)即释放抑制。
  useEffect(() => {
    if (!didInitRef.current) return
    urlTimerRef.current = setTimeout(() => {
      urlTimerRef.current = null
      const target = currentTarget()
      const cur = window.location.pathname + window.location.search
      if (applyingRef.current) {
        if (target === cur) applyingRef.current = false
        return
      }
      if (target !== cur) window.history.pushState(null, '', target)
    }, 20)
    return () => { if (urlTimerRef.current) { clearTimeout(urlTimerRef.current); urlTimerRef.current = null } }
  }, [currentTarget])

  // 记住当前打开的笔记本/文章(恢复完成后才开始写,避免覆盖已存值)
  useEffect(() => {
    if (!restoredRef.current) return
    if (activeNotebook) localStorage.setItem('cfnote-last-notebook', String(activeNotebook.id))
    else localStorage.removeItem('cfnote-last-notebook')
  }, [activeNotebook])
  useEffect(() => {
    if (!restoredRef.current) return
    if (activeArticle && activeArticle.id > 0) localStorage.setItem('cfnote-last-article', String(activeArticle.id))
    else if (!activeArticle) localStorage.removeItem('cfnote-last-article')
  }, [activeArticle])

  const createNotebook = async (name: string) => {
    const res = await post<Notebook>('/notebooks', { name })
    if (res.ok) await loadNotebooks()
    return res
  }

  const deleteNotebook = async (id: number) => {
    const res = await del(`/notebooks/${id}`)
    if (res.ok) {
      if (activeNotebook?.id === id) setActiveNotebook(null)
      await loadNotebooks()
    }
    return res
  }

  // P9.3 笔记模板:存在名为「模板」的笔记本且有内容时,新建笔记先弹选择(空白/套用模板)
  const [templatePick, setTemplatePick] = useState<Article[] | null>(null)

  const startDraft = (tpl?: Article) => {
    if (!activeNotebook || activeNotebook.id < 0) return
    setTemplatePick(null)
    // 本地草稿:不落库。用户首次输入触发保存时才真正创建记录(见 saveArticle 的 id<0 分支)
    setActiveArticle({
      id: -Date.now(), notebook_id: activeNotebook.id,
      title: tpl?.title || '无标题文章', content: tpl?.content ?? '',
      tags: tpl?.tags ?? null,
      is_vectorized: 0, is_public: 0, is_private: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as Article)
  }

  const createArticle = async () => {
    if (!activeNotebook || activeNotebook.id < 0) return
    const tplNb = notebooks.find((n) => n.name === '模板')
    if (tplNb && tplNb.id !== activeNotebook.id && tplNb.article_count > 0) {
      const res = await get<Article[]>(`/notebooks/${tplNb.id}/articles`)
      if (res.ok && res.data && res.data.length > 0) {
        setTemplatePick(res.data)
        return
      }
    }
    startDraft()
  }

  // 套用模板:列表项只有摘要,取全文后再开草稿
  const useTemplate = async (id: number) => {
    const res = await get<Article>(`/articles/${id}`)
    if (res.ok && res.data) startDraft(res.data)
    else setTemplatePick(null)
  }

  const saveArticle = async (id: number, data: { title?: string; content?: string; is_public?: number; is_private?: number; tags?: string[]; pinned?: number }) => {
    // 草稿首次保存:创建真实文章并替换草稿
    if (id < 0) {
      if (!activeNotebook || activeNotebook.id < 0) return { ok: false, error: '未选择笔记本' }
      const res = await post<Article>('/articles', {
        notebook_id: activeNotebook.id,
        title: data.title?.trim() || '无标题文章',
        content: data.content ?? '',
        tags: data.tags,
      })
      if (res.ok && res.data) {
        setActiveArticle(res.data)
        loadArticles(activeNotebook)
        loadNotebooks()
        loadTags()
      }
      return res
    }
    const res = await put<Article>(`/articles/${id}`, data)
    if (res.ok && res.data) {
      setActiveArticle(res.data)
      if (activeNotebook) loadArticles(activeNotebook)
      if (data.tags !== undefined) loadTags()
    }
    return res
  }

  const [deletingArticleId, setDeletingArticleId] = useState<number | null>(null)
  const deleteArticle = async (id: number) => {
    setDeletingArticleId(id)
    try {
      const res = await del(`/articles/${id}`)
      if (res.ok) {
        if (activeArticle?.id === id) setActiveArticle(null)
        if (activeNotebook) {
          await loadArticles(activeNotebook)
          loadNotebooks()
        }
        loadTags()
      }
      return res
    } finally {
      setDeletingArticleId(null)
    }
  }

  // ---- P9 回收站与置顶 ----

  const restoreArticle = async (id: number) => {
    const res = await post(`/articles/${id}/restore`, {})
    if (res.ok) {
      if (activeArticle?.id === id) setActiveArticle(null)
      if (activeNotebook) loadArticles(activeNotebook)
      loadNotebooks()
      loadTags()
    }
    return res
  }

  const purgeArticle = async (id: number) => {
    const res = await del(`/articles/${id}/purge`)
    if (res.ok) {
      if (activeArticle?.id === id) setActiveArticle(null)
      if (activeNotebook) loadArticles(activeNotebook)
      loadTags()
    }
    return res
  }

  const emptyTrash = async () => {
    const res = await post('/articles/trash/empty', {})
    if (res.ok) {
      setActiveArticle(null)
      if (activeNotebook) loadArticles(activeNotebook)
      loadTags()
    }
    return res
  }

  const togglePin = async (a: Article) => {
    const res = await put(`/articles/${a.id}`, { pinned: a.pinned ? 0 : 1 })
    if (res.ok && activeNotebook) loadArticles(activeNotebook)
    return res
  }

  // Import article from URL
  const importArticle = async (url: string) => {
    if (!activeNotebook) return
    setImporting(true)
    try {
      const res = await post<Article>('/articles/import', {
        url,
        notebook_id: activeNotebook.id,
      })
      if (!res.ok) throw new Error(res.error || '导入失败')
      if (res.data) {
        setActiveArticle(res.data)
        setShowImport(false)
        loadArticles(activeNotebook)
        loadNotebooks()
      }
    } finally {
      setImporting(false)
    }
  }

  // 批量导入本地文档(.md/.markdown/.txt):复用备份导入接口 + 分批建索引
  const [importProgress, setImportProgress] = useState('')
  const importLocalFiles = async (files: File[]) => {
    if (!activeNotebook || files.length === 0) return
    setImporting(true)
    setImportProgress(`正在读取 ${files.length} 个文件...`)
    try {
      const arts: { id: number; notebook_id: number; title: string; content: string }[] = []
      for (const f of files) {
        const content = await f.text()
        const title = f.name.replace(/\.(md|markdown|txt)$/i, '') || f.name
        arts.push({ id: arts.length + 1, notebook_id: 1, title, content })
      }
      setImportProgress('正在导入文章...')
      const res = await post<{ articles_imported: number; articles_skipped: number }>('/import', {
        app: 'cfnote',
        export_version: 1,
        notebooks: [{ id: 1, name: activeNotebook.name }],
        articles: arts,
      })
      if (!res.ok || !res.data) throw new Error(res.error || '导入失败')
      const { articles_imported } = res.data

      // 分批建立向量索引(每批一次独立请求;剩余不再减少说明持续失败,停止)
      let lastRemaining = Infinity
      while (articles_imported > 0) {
        const r = await post<{ processed: number; remaining: number }>('/reindex', {})
        if (!r.ok || !r.data) break
        if (r.data.remaining === 0 || r.data.remaining >= lastRemaining) break
        lastRemaining = r.data.remaining
        setImportProgress(`正在建立向量索引... 剩余 ${r.data.remaining} 篇`)
      }

      setShowImport(false)
      loadArticles(activeNotebook)
      loadNotebooks()
    } finally {
      setImporting(false)
      setImportProgress('')
    }
  }

  return (
    <div className="h-screen flex flex-col bg-white">
      {/* Top Bar */}
      <header className="h-13 border-b border-gray-200 flex items-center px-4 shrink-0 bg-white z-10">
        {/* 折叠/展开左侧笔记本列表(桌面与移动端通用,状态存 localStorage) */}
        <button onClick={toggleSidebar} className="p-1.5 rounded-lg hover:bg-gray-100 mr-3" title={sidebarOpen ? '折叠侧栏' : '展开侧栏'}>
          <svg className="w-5 h-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-emerald-500 rounded-lg flex items-center justify-center">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <span className="font-semibold text-gray-900 text-sm">CFNote</span>
        </div>

        <button
          onClick={() => setShowSearch(!showSearch)}
          className="ml-4 flex items-center gap-2 bg-gray-100 hover:bg-gray-200 rounded-lg px-3 py-1.5 text-sm text-gray-500 transition-colors flex-1 max-w-xs"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          搜索知识库...
        </button>

        <div className="ml-auto flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-emerald-600 transition-colors"
            title={dark ? '切换到浅色模式' : '切换到深色模式'}
          >
            {dark ? (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
            ) : (
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
              </svg>
            )}
          </button>
          <button
            onClick={() => setShowReminders((v) => !v)}
            className={`relative p-1.5 rounded-lg hover:bg-gray-100 transition-colors ${showReminders ? 'text-emerald-600 bg-emerald-50' : 'text-gray-400 hover:text-emerald-600'}`}
            title="提醒"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
            </svg>
            {dueCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
                {dueCount > 99 ? '99+' : dueCount}
              </span>
            )}
          </button>
          <button
            onClick={() => setShowStats(!showStats)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-emerald-600 transition-colors"
            title="使用统计"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
          <button
            onClick={() => { setSettingsFocus(null); setShowSettings(!showSettings) }}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-emerald-600 transition-colors"
            title="设置"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-emerald-600 transition-colors"
            title="系统日志"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          </button>
          <button
            onClick={() => setChatOpen(!showChat)}
            className={`p-1.5 rounded-lg hover:bg-gray-100 transition-colors ${showChat ? 'text-emerald-600 bg-emerald-50' : 'text-gray-400 hover:text-emerald-600'}`}
            title="AI 助手"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
          </button>
          <span className="text-sm text-gray-500">{username}</span>
          <button onClick={onLogout} className="text-sm text-gray-400 hover:text-red-500 transition-colors">退出</button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        <div className={`${sidebarOpen ? 'w-56' : 'w-0'} transition-all duration-200 overflow-hidden border-r border-gray-200 bg-gray-50/70 shrink-0`}>
          <Sidebar
            notebooks={notebooks}
            activeNotebook={activeNotebook}
            tags={tags}
            onSelect={(nb) => { setActiveNotebook(nb); setBlogView(null); closeFiles() }}
            onCreate={createNotebook}
            onDelete={deleteNotebook}
            onOpenFiles={() => { setShowFiles(true); setBlogView(null) }}
            filesActive={showFiles}
            fileNavSlot={showFiles ? (
              <Suspense fallback={<p className="pl-8 py-1 text-[11px] text-gray-400">加载中…</p>}>
                <FileManagerNav view={fmView} onChangeView={setFmView} fm={fm} />
              </Suspense>
            ) : null}
            blogView={blogView}
            onOpenBlog={(v) => { setBlogView(v); closeFiles() }}
          />
        </div>

        {blogView ? (
          /* 博客管理(P11.4):内联占据侧栏右侧整个工作区,不再弹窗 */
          <div className="flex-1 overflow-hidden">
            <Suspense fallback={<div className="h-full flex items-center justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>}>
              <BlogManager
                token={token}
                notebooks={notebooks}
                tab={blogView}
                onTabChange={(v) => setBlogView(v)}
                onClose={() => setBlogView(null)}
                onOpenArticle={openArticleWithSnippet}
              />
            </Suspense>
          </div>
        ) : showFiles ? (
          /* 文件管理(P11.5):同样内联展示,不再弹窗 */
          <div className="flex-1 overflow-hidden">
            <Suspense fallback={<div className="h-full flex items-center justify-center"><div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" /></div>}>
              <FileManager
                token={token}
                onClose={closeFiles}
                view={fmView}
                onChangeView={setFmView}
                fm={fm}
                onOpenSettings={() => { setSettingsFocus('files'); setShowSettings(true) }}
              />
            </Suspense>
          </div>
        ) : (
          <>
        <div className="relative border-r border-gray-200 bg-white shrink-0 flex flex-col overflow-hidden" style={{ width: listWidth }}>
          <ArticleList
            articles={articles}
            activeArticle={activeArticle}
            notebookName={activeNotebook?.name}
            virtual={!!activeNotebook && activeNotebook.id < 0}
            trash={activeNotebook?.id === TRASH_NOTEBOOK.id}
            deletingId={deletingArticleId}
            onSelect={openArticle}
            onCreate={createArticle}
            onDelete={deleteArticle}
            onImport={() => setShowImport(true)}
            onRestore={restoreArticle}
            onPurge={purgeArticle}
            onEmptyTrash={emptyTrash}
            onTogglePin={togglePin}
          />
          {/* 列表右缘拖拽条:调整列表/正文分配 */}
          <div
            onMouseDown={startListResize}
            className={`absolute right-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-300 active:bg-emerald-400 z-10 transition-colors ${listDragging ? 'bg-emerald-400' : ''}`}
            title="拖拽调整宽度"
          />
        </div>

        <div className="flex-1 overflow-hidden">
          {activeArticle ? (
            <ArticleEditor article={activeArticle} token={token} onSave={saveArticle} highlight={highlight} loadingContent={articleLoading} allTags={tags.map((t) => t.name)} onOpenArticle={(id) => openArticleWithSnippet(id)} onRemindersChanged={loadReminders} />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-400">
              <div className="text-center">
                <svg className="w-16 h-16 mx-auto mb-4 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
                <p>{activeNotebook ? '选择或创建一篇文章' : '选择一个笔记本开始'}</p>
              </div>
            </div>
          )}
        </div>

        {/* AI Chat Panel(宽度可拖拽,300px ~ 屏幕一半) */}
        <div
          className={`relative ${chatDragging ? '' : 'transition-[width] duration-300'} overflow-hidden border-l border-gray-200 shrink-0`}
          style={{ width: showChat ? chatWidth : 0 }}
        >
          {showChat && (
            <div
              onMouseDown={startChatResize}
              className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize hover:bg-emerald-300 active:bg-emerald-400 z-10 transition-colors"
              title="拖拽调整宽度"
            />
          )}
          <div style={{ width: chatWidth }} className="h-full">
            <AiChatPanel
              token={token}
              onClose={() => setChatOpen(false)}
              onOpenArticle={openArticleWithSnippet}
            />
          </div>
        </div>
          </>
        )}
      </div>

      {showSearch && (
        <SearchPanel token={token} onClose={() => setShowSearch(false)} onOpenArticle={(id, snippet) => { openArticleWithSnippet(id, snippet); setShowSearch(false) }} />
      )}

      {showReminders && (
        <RemindersPanel
          token={token}
          reminders={reminders}
          onClose={() => setShowReminders(false)}
          onOpenArticle={openArticleWithSnippet}
          onChanged={loadReminders}
        />
      )}

      {showStats && (
        <StatsPanel token={token} onClose={() => setShowStats(false)} />
      )}

      {showSettings && (
        <SettingsPanel
          token={token}
          focus={settingsFocus}
          onClose={() => { setShowSettings(false); setSettingsFocus(null) }}
        />
      )}

      {showLogs && (
        <SystemLogsPanel token={token} onClose={() => setShowLogs(false)} />
      )}

      {showImport && (
        <ImportDialog
          loading={importing}
          progress={importProgress}
          onImport={importArticle}
          onImportFiles={importLocalFiles}
          onClose={() => !importing && setShowImport(false)}
        />
      )}

      {/* P9.3 模板选择:新建笔记时从「模板」笔记本套用 */}
      {templatePick && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => setTemplatePick(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 max-w-[92vw] p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">新建笔记</h3>
            <p className="text-[11px] text-gray-400 mb-2">从「模板」笔记本选择一篇作为起点,或从空白开始。</p>
            <div className="max-h-64 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
              <button onClick={() => startDraft()} className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50">
                📄 空白笔记
              </button>
              {templatePick.map((t) => (
                <button
                  key={t.id}
                  onClick={() => useTemplate(t.id)}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50 truncate"
                >
                  📋 {t.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
