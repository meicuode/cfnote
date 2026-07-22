import { useState, useEffect, useCallback, useRef } from 'react'
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
import type { Notebook, Article } from '../types'

interface Props {
  token: string
  username: string
  onLogout: () => void
}

export default function Layout({ token, username, onLogout }: Props) {
  const { get, post, put, del } = useApi(token, onLogout)
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [activeNotebook, setActiveNotebook] = useState<Notebook | null>(null)
  const [articles, setArticles] = useState<Article[]>([])
  const [activeArticle, setActiveArticle] = useState<Article | null>(null)
  const [showSearch, setShowSearch] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [importing, setImporting] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [showChat, setShowChat] = useState(false)
  const chatMaxWidth = () => Math.max(300, Math.floor(window.innerWidth / 2))
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(localStorage.getItem('cfnote-chat-width'))
    return saved >= 300 && saved <= chatMaxWidth() ? saved : 380
  })
  const [chatDragging, setChatDragging] = useState(false)
  const [highlight, setHighlight] = useState<{ text: string; ts: number } | null>(null)
  const restoredRef = useRef(false)

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

  // 从 AI 对话/搜索打开文章:可携带引用片段用于定位高亮
  const openArticleWithSnippet = (id: number, snippet?: string) => {
    loadArticleDetail(id)
    if (snippet) setHighlight({ text: snippet, ts: Date.now() })
  }

  const loadNotebooks = useCallback(async () => {
    const res = await get<Notebook[]>('/notebooks')
    if (res.ok && res.data) setNotebooks(res.data)
  }, [get])

  useEffect(() => { loadNotebooks() }, [loadNotebooks])

  const loadArticles = useCallback(async (notebookId: number) => {
    const res = await get<Article[]>(`/notebooks/${notebookId}/articles`)
    if (res.ok && res.data) setArticles(res.data)
  }, [get])

  useEffect(() => {
    if (activeNotebook) {
      loadArticles(activeNotebook.id)
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

  // 首次加载完笔记本列表后,恢复上次打开的笔记本与文章
  useEffect(() => {
    if (restoredRef.current || notebooks.length === 0) return
    restoredRef.current = true
    const nb = notebooks.find((n) => n.id === Number(localStorage.getItem('cfnote-last-notebook')))
    if (!nb) return
    setActiveNotebook(nb)
    const artId = Number(localStorage.getItem('cfnote-last-article'))
    if (artId) loadArticleDetail(artId)
  }, [notebooks, loadArticleDetail])

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

  const createArticle = async () => {
    if (!activeNotebook) return
    // 乐观切换:立即打开临时空文章(只读),创建成功后无缝替换为真实文章
    const temp: Article = {
      id: -1, notebook_id: activeNotebook.id, title: '无标题文章', content: '',
      is_vectorized: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    } as Article
    setActiveArticle(temp)
    setArticleLoading(true)
    const res = await post<Article>('/articles', {
      notebook_id: activeNotebook.id,
      title: '无标题文章',
      content: '',
    })
    setArticleLoading(false)
    if (res.ok && res.data) {
      setActiveArticle(res.data)
      loadArticles(activeNotebook.id)
      loadNotebooks()
    } else {
      setActiveArticle(null)
    }
  }

  const saveArticle = async (id: number, data: { title?: string; content?: string }) => {
    const res = await put<Article>(`/articles/${id}`, data)
    if (res.ok && res.data) {
      setActiveArticle(res.data)
      if (activeNotebook) loadArticles(activeNotebook.id)
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
          await loadArticles(activeNotebook.id)
          loadNotebooks()
        }
      }
      return res
    } finally {
      setDeletingArticleId(null)
    }
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
        loadArticles(activeNotebook.id)
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
      loadArticles(activeNotebook.id)
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
        <button onClick={() => setSidebarOpen(!sidebarOpen)} className="p-1.5 rounded-lg hover:bg-gray-100 mr-3 lg:hidden">
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
            onClick={() => setShowStats(!showStats)}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-emerald-600 transition-colors"
            title="使用统计"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
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
            onClick={() => setShowChat(!showChat)}
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
            onSelect={setActiveNotebook}
            onCreate={createNotebook}
            onDelete={deleteNotebook}
          />
        </div>

        <div className="w-72 border-r border-gray-200 bg-white shrink-0 flex flex-col overflow-hidden">
          <ArticleList
            articles={articles}
            activeArticle={activeArticle}
            notebookName={activeNotebook?.name}
            deletingId={deletingArticleId}
            onSelect={openArticle}
            onCreate={createArticle}
            onDelete={deleteArticle}
            onImport={() => setShowImport(true)}
          />
        </div>

        <div className="flex-1 overflow-hidden">
          {activeArticle ? (
            <ArticleEditor article={activeArticle} onSave={saveArticle} highlight={highlight} loadingContent={articleLoading} />
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
              onClose={() => setShowChat(false)}
              onOpenArticle={openArticleWithSnippet}
            />
          </div>
        </div>
      </div>

      {showSearch && (
        <SearchPanel token={token} onClose={() => setShowSearch(false)} onOpenArticle={(id, snippet) => { openArticleWithSnippet(id, snippet); setShowSearch(false) }} />
      )}

      {showStats && (
        <StatsPanel token={token} onClose={() => setShowStats(false)} />
      )}

      {showSettings && (
        <SettingsPanel token={token} onClose={() => setShowSettings(false)} />
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
    </div>
  )
}
