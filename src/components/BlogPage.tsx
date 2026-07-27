import { useEffect, useRef, useState } from 'react'
import { marked } from '../lib/markdown'
import { enhanceRendered } from '../lib/renderEnhance'
import { initialBlogTheme, storedBlogTheme, saveBlogTheme, type BlogTheme } from '../lib/blogTheme'

// 公开博客页(IT之家风格布局,见 docs/public-blog.md):
// 免登录,数据来自 /api/blog/*(仅公开且非私有的笔记)。/blog 列表,/blog/:id 详情,pushState 路由。
// 亮/暗双主题:默认跟随系统,导航栏可手动切换(存 localStorage);顶栏与页脚保持黑色 chrome,
// 内容区配色走 index.css 的 --blog-* 变量(深色时根元素额外挂 dark)。

interface BlogPost {
  id: number
  title: string
  tag: string
  tags?: string[]
  excerpt: string
  thumb: string | null
  published_at: string
  views: number
}

interface BlogDetail {
  id: number
  title: string
  content: string
  tag: string
  tags?: string[]
  /** 私密分享视图(P9.3):不在博客列表/热榜,凭链接访问 */
  shared?: boolean
  /** 评论开关(P11.2;仅公开详情返回) */
  comments_enabled?: boolean
  published_at: string
  views: number
}

interface HotItem {
  id: number
  title: string
  views: number
}

// /blog/<id> 公开文章;/blog/share/<token> 私密分享(P9.3,字符串即 token)
const parsePath = (): number | string | null => {
  const s = /^\/blog\/share\/([0-9a-f]{32})/.exec(window.location.pathname)
  if (s) return s[1]
  const m = /^\/blog\/(\d+)/.exec(window.location.pathname)
  return m ? Number(m[1]) : null
}

// sqlite 的 datetime('now') 是 UTC 且无时区标记,补 Z 再转本地
const toDate = (d: string) => new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(d) ? d : d.replace(' ', 'T') + 'Z')

// 列表时间:今日 9:12 / 昨日 18:00 / 07-20 10:00
function fmtTime(d: string): string {
  const date = toDate(d)
  if (isNaN(date.getTime())) return ''
  const now = new Date()
  const hm = `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
  if (date.toDateString() === now.toDateString()) return `今日 ${hm}`
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (date.toDateString() === yest.toDateString()) return `昨日 ${hm}`
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${hm}`
}

// 详情元信息:2026/7/24 7:26:56
function fmtFull(d: string): string {
  const t = toDate(d)
  if (isNaN(t.getTime())) return ''
  return `${t.getFullYear()}/${t.getMonth() + 1}/${t.getDate()} ${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
}

function renderMd(md: string): { __html: string } {
  try {
    return { __html: marked(md || '', { breaks: true }) as string }
  } catch {
    return { __html: md }
  }
}

const Spinner = () => (
  <div className="py-24 flex justify-center">
    <div className="w-6 h-6 border-2 border-[#d43030] border-t-transparent rounded-full animate-spin" />
  </div>
)

// ---- 评论(P11.2)----
// 正文一律纯文本渲染({c.content} 由 React 自动转义 + whitespace-pre-wrap),不解析 markdown/HTML,杜绝 XSS。
interface CommentRowData {
  id: number
  parent_id: number | null
  root_id: number | null
  author_name: string
  content: string
  is_admin?: number | boolean
  created_at: string
}
interface CommentThread extends CommentRowData {
  replies: CommentRowData[]
}

function CommentRow({ c, enabled, onReply, parentName }: {
  c: CommentRowData
  enabled: boolean
  onReply: (r: { id: number; name: string }) => void
  parentName?: string
}) {
  return (
    <div>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-medium text-[var(--blog-title)]">{c.author_name}</span>
        {c.is_admin ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#d43030] text-white">博主</span> : null}
        {parentName && <span className="text-xs text-[var(--blog-muted)]">回复 @{parentName}</span>}
        <span className="text-xs text-[var(--blog-muted)] ml-auto">{fmtFull(c.created_at)}</span>
      </div>
      <div className="text-sm text-[var(--blog-text)] mt-1 whitespace-pre-wrap break-words">{c.content}</div>
      {enabled && (
        <button onClick={() => onReply({ id: c.id, name: c.author_name })} className="text-xs text-[var(--blog-muted)] hover:text-[#e05252] mt-1">回复</button>
      )}
    </div>
  )
}

// 楼中楼的「回复 @X」:回复对象不是楼主本身时才显示
function replyParentName(top: CommentThread, r: CommentRowData): string | undefined {
  if (r.parent_id == null || r.parent_id === top.id) return undefined
  return top.replies.find((x) => x.id === r.parent_id)?.author_name
}

function CommentsSection({ articleId, enabled }: { articleId: number; enabled: boolean }) {
  const [threads, setThreads] = useState<CommentThread[] | null>(null)
  const [name, setName] = useState(() => localStorage.getItem('cfnote-cmt-name') || '')
  const [email, setEmail] = useState(() => localStorage.getItem('cfnote-cmt-email') || '')
  const [content, setContent] = useState('')
  const [website, setWebsite] = useState('') // 蜜罐
  const [replyTo, setReplyTo] = useState<{ id: number; name: string } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () => {
    fetch(`/api/blog/comments?article_id=${articleId}`)
      .then((r) => r.json() as Promise<any>)
      .then((j) => setThreads(j.ok && Array.isArray(j.data) ? j.data : []))
      .catch(() => setThreads([]))
  }
  useEffect(() => { load() }, [articleId])

  const count = threads ? threads.reduce((n, t) => n + 1 + t.replies.length, 0) : 0

  const submit = async () => {
    if (submitting) return
    if (!name.trim()) { setMsg('请填写昵称'); return }
    if (!content.trim()) { setMsg('评论内容不能为空'); return }
    setSubmitting(true); setMsg('')
    try {
      const res = await fetch('/api/blog/comments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          article_id: articleId,
          parent_id: replyTo?.id,
          author_name: name.trim(),
          author_email: email.trim() || undefined,
          content: content.trim(),
          website,
        }),
      })
      const j = (await res.json()) as any
      if (j.ok) {
        localStorage.setItem('cfnote-cmt-name', name.trim())
        if (email.trim()) localStorage.setItem('cfnote-cmt-email', email.trim())
        setContent(''); setReplyTo(null)
        if (j.data?.status === 'approved') { setMsg('评论已发布'); load() }
        else setMsg('评论已提交,待博主审核后显示')
      } else setMsg(j.error || '提交失败')
    } catch {
      setMsg('提交失败,请稍后重试')
    }
    setSubmitting(false)
  }

  return (
    <section className="mt-10 mb-4">
      <div className="flex items-end justify-between border-b-2 border-[#d43030] pb-2">
        <h3 className="text-xl font-bold text-[var(--blog-title)]">评论{count > 0 ? ` (${count})` : ''}</h3>
        <span className="text-xs text-gray-500 hidden sm:block">愿每一段记录,都有回响。</span>
      </div>

      {enabled ? (
        <div className="mt-4 bg-[var(--blog-card)] border border-[var(--blog-border)] rounded-lg p-4">
          {replyTo && (
            <div className="text-xs text-[var(--blog-muted)] mb-2">
              回复 @{replyTo.name}
              <button onClick={() => setReplyTo(null)} className="text-[#e05252] hover:underline ml-1">取消</button>
            </div>
          )}
          <div className="flex flex-col sm:flex-row gap-2 mb-2">
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="昵称(必填)" className="flex-1 text-sm rounded border border-[var(--blog-border)] bg-[var(--blog-bg)] text-[var(--blog-text)] px-3 py-2 outline-none focus:border-[#d43030]" />
            <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱(可选,不公开)" className="flex-1 text-sm rounded border border-[var(--blog-border)] bg-[var(--blog-bg)] text-[var(--blog-text)] px-3 py-2 outline-none focus:border-[#d43030]" />
          </div>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} rows={3} placeholder="写下你的评论…" className="w-full text-sm rounded border border-[var(--blog-border)] bg-[var(--blog-bg)] text-[var(--blog-text)] px-3 py-2 outline-none focus:border-[#d43030] resize-y" />
          {/* 蜜罐:视觉移出屏幕,真人看不见;机器人常自动填充 → 后端静默丢弃 */}
          <input value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden="true" className="absolute -left-[9999px] w-px h-px overflow-hidden" />
          <div className="flex items-center justify-between mt-2">
            <span className="text-xs text-[var(--blog-muted)]">{msg}</span>
            <button onClick={submit} disabled={submitting} className="px-4 py-1.5 rounded bg-[#d43030] text-white text-sm hover:bg-[#e05252] disabled:opacity-50">
              {submitting ? '提交中…' : replyTo ? '回复' : '发表评论'}
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-[var(--blog-panel)] rounded mt-4 py-5 text-center text-sm text-[var(--blog-muted)]">评论已关闭</div>
      )}

      <div className="mt-6 space-y-5">
        {threads === null ? (
          <div className="py-6 flex justify-center"><div className="w-5 h-5 border-2 border-[#d43030] border-t-transparent rounded-full animate-spin" /></div>
        ) : threads.length === 0 ? (
          <p className="text-center text-sm text-[var(--blog-muted)] py-6">还没有评论,来抢沙发~</p>
        ) : (
          threads.map((t) => (
            <div key={t.id}>
              <CommentRow c={t} enabled={enabled} onReply={setReplyTo} />
              {t.replies.length > 0 && (
                <div className="mt-3 ml-6 sm:ml-10 space-y-3 border-l-2 border-[var(--blog-border)] pl-4">
                  {t.replies.map((r) => (
                    <CommentRow key={r.id} c={r} enabled={enabled} onReply={setReplyTo} parentName={replyParentName(t, r)} />
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  )
}

export default function BlogPage() {
  const [postId, setPostId] = useState<number | string | null>(parsePath())
  const [posts, setPosts] = useState<BlogPost[] | null>(null)
  const [detail, setDetail] = useState<BlogDetail | null>(null)
  const [detailErr, setDetailErr] = useState('')
  const [hot, setHot] = useState<HotItem[]>([])
  const [hotRange, setHotRange] = useState<'day' | 'week' | 'month'>('day')
  const [theme, setTheme] = useState<BlogTheme>(initialBlogTheme)
  const [themeManual, setThemeManual] = useState(() => storedBlogTheme() != null)
  const [showTop, setShowTop] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)

  // 详情渲染后做代码高亮 + 公式 + Mermaid(懒加载 hljs/KaTeX/mermaid)。
  // 与编辑器预览同一套路,用 MutationObserver 兜底重跑(各库靠 data-* 标记幂等,不会重复处理):
  // 一次性 effect 在异步 import 期间若遇到 React 重渲染(主题切换/热榜/评论加载)或内容注入,
  // 捕获到的旧节点可能被换掉导致高亮丢失;观察者在 DOM 落定后再增强,确保稳定生效。
  useEffect(() => {
    const root = contentRef.current
    if (!detail || !root) return
    enhanceRendered(root)
    const mo = new MutationObserver(() => enhanceRendered(root))
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [detail])

  useEffect(() => {
    const onPop = () => setPostId(parsePath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // 未手动选过主题时跟随系统实时变化;手动选择后固定
  useEffect(() => {
    if (themeManual) return
    try {
      const mq = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = (e: MediaQueryListEvent) => setTheme(e.matches ? 'dark' : 'light')
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    } catch {
      /* 环境不支持监听:保持初始主题 */
    }
  }, [themeManual])

  const toggleTheme = () => {
    const next: BlogTheme = theme === 'dark' ? 'light' : 'dark'
    saveBlogTheme(next)
    setThemeManual(true)
    setTheme(next)
  }

  useEffect(() => {
    fetch('/api/blog/posts')
      .then((r) => r.json() as Promise<any>)
      .then((j) => setPosts(j.ok ? j.data : []))
      .catch(() => setPosts([]))
  }, [])

  useEffect(() => {
    fetch(`/api/blog/hot?range=${hotRange}`)
      .then((r) => r.json() as Promise<any>)
      .then((j) => setHot(j.ok ? j.data : []))
      .catch(() => setHot([]))
  }, [hotRange])

  useEffect(() => {
    if (postId == null) {
      setDetail(null)
      setDetailErr('')
      document.title = 'CFNote 博客'
      return
    }
    setDetail(null)
    setDetailErr('')
    window.scrollTo(0, 0)
    // 数字 id 为公开文章;字符串为私密分享 token
    fetch(typeof postId === 'string' ? `/api/blog/share/${postId}` : `/api/blog/posts/${postId}`)
      .then((r) => r.json() as Promise<any>)
      .then((j) => {
        if (j.ok) {
          setDetail(j.data)
          document.title = `${j.data.title} - CFNote 博客`
        } else {
          setDetailErr(j.error || '加载失败')
        }
      })
      .catch(() => setDetailErr('加载失败,请稍后重试'))
  }, [postId])

  // 详情页滚过约一屏后显示「回到顶部」
  useEffect(() => {
    if (postId == null) {
      setShowTop(false)
      return
    }
    const onScroll = () => setShowTop(window.scrollY > 480)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [postId])

  const openPost = (id: number) => {
    window.history.pushState(null, '', `/blog/${id}`)
    setPostId(id)
  }
  const goHome = () => {
    window.history.pushState(null, '', '/blog')
    setPostId(null)
  }

  return (
    <div className={`${theme === 'dark' ? 'dark ' : ''}cfnote-blog min-h-screen bg-[var(--blog-bg)] flex flex-col`}>
      {/* 顶栏(两种主题下都保持黑色 chrome;文字用固定色值,避开应用深色映射对 gray 类的重排) */}
      <nav className="bg-[#0d0d0d] sticky top-0 z-20">
        <div className="max-w-[1400px] mx-auto px-5 h-14 flex items-center">
          <button onClick={goHome} className="flex items-center gap-2 mr-8 shrink-0">
            <span className="w-8 h-8 rounded bg-[#d43030] text-white font-black flex items-center justify-center text-sm tracking-tight">CF</span>
            <span className="text-white font-bold text-xl">
              Note<span className="text-[#d43030] ml-0.5">博客</span>
            </span>
          </button>
          <button
            onClick={goHome}
            className={`h-full px-4 text-[15px] border-b-2 transition-colors ${
              postId == null ? 'text-white border-[#d43030] font-medium' : 'text-[#c9c9c9] border-transparent hover:text-white'
            }`}
          >
            首页
          </button>
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={toggleTheme}
              title={theme === 'dark' ? '切换为明亮主题' : '切换为黑暗主题'}
              aria-label="切换明暗主题"
              className="w-9 h-9 rounded-full flex items-center justify-center text-[#c9c9c9] hover:text-white hover:bg-white/10 transition-colors"
            >
              {theme === 'dark' ? (
                /* 太阳:当前深色,点击转亮 */
                <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z" />
                </svg>
              ) : (
                /* 月亮:当前明亮,点击转暗 */
                <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" strokeWidth={1.8} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z" />
                </svg>
              )}
            </button>
            <a href="/" className="pl-2 text-sm text-[#c9c9c9] hover:text-white transition-colors">
              进入笔记本 →
            </a>
          </div>
        </div>
      </nav>

      <div className="max-w-[1400px] w-full mx-auto px-5 py-5 flex items-start gap-7 flex-1">
        <main className="flex-1 min-w-0">
          {postId == null ? (
            /* ---- 列表 ---- */
            posts === null ? (
              <Spinner />
            ) : posts.length === 0 ? (
              <div className="py-24 text-center text-gray-500">
                <p className="text-4xl mb-3">📝</p>
                <p>还没有公开的笔记</p>
                <p className="text-sm mt-1 text-gray-600">在笔记本中点击「公开」即可发布到这里</p>
              </div>
            ) : (
              posts.map((p) => (
                <article
                  key={p.id}
                  onClick={() => openPost(p.id)}
                  className="flex gap-5 py-6 border-b border-[var(--blog-border)] cursor-pointer group"
                >
                  {p.thumb ? (
                    <img
                      src={p.thumb}
                      alt=""
                      loading="lazy"
                      className="w-[130px] h-[80px] sm:w-[215px] sm:h-[125px] object-cover rounded-md bg-black/30 shrink-0"
                    />
                  ) : (
                    <div className="w-[130px] h-[80px] sm:w-[215px] sm:h-[125px] rounded-md shrink-0 bg-gradient-to-br from-[var(--blog-thumb1)] to-[var(--blog-thumb2)] flex flex-col items-center justify-center gap-1">
                      <span className="text-2xl">📝</span>
                      <span className="text-xs text-gray-500 hidden sm:block">CFNote</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0 flex flex-col py-0.5">
                    <h2 className="text-base sm:text-[19px] font-bold leading-snug text-[var(--blog-title)] group-hover:text-[#e05252] transition-colors line-clamp-2">
                      {p.title}
                    </h2>
                    {p.excerpt && <p className="text-sm text-[#999] mt-2.5 leading-relaxed line-clamp-2 hidden sm:block">{p.excerpt}</p>}
                    <div className="mt-auto pt-3 flex items-center text-sm min-w-0">
                      <span className="text-[#8f8f8f] truncate">
                        Tags：{[p.tag, ...(p.tags || [])].join('、')}
                      </span>
                      <span className="ml-auto pl-3 text-[#e05252] shrink-0">{fmtTime(p.published_at)}</span>
                    </div>
                  </div>
                </article>
              ))
            )
          ) : /* ---- 详情 ---- */
          detailErr ? (
            <div className="py-24 text-center text-gray-500">
              <p>{detailErr}</p>
              <button onClick={goHome} className="mt-3 text-sm text-[#e05252] hover:underline">
                返回首页
              </button>
            </div>
          ) : !detail ? (
            <Spinner />
          ) : (
            <div className="pt-1">
              {/* 面包屑 */}
              <div className="text-[15px] flex items-center gap-2">
                <button onClick={goHome} className="text-[#8f8f8f] hover:text-[#e05252] transition-colors">
                  首页
                </button>
                <span className="text-[#8f8f8f]">&gt;</span>
                <span className="text-[#8f8f8f]">{detail.tag}</span>
                {detail.shared && (
                  <span className="text-[12px] px-1.5 py-0.5 rounded bg-[#e05252]/10 text-[#e05252]" title="凭链接访问的私密分享,不会出现在博客列表">
                    私密分享
                  </span>
                )}
              </div>
              <h1 className="text-[26px] sm:text-[28px] font-bold leading-snug text-[var(--blog-title)] mt-5">{detail.title}</h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-gray-500 mt-4">
                <span>{fmtFull(detail.published_at)}</span>
                <span>来源：CFNote 笔记</span>
                <span>Tags：{[detail.tag, ...(detail.tags || [])].join('、')}</span>
                <span className="ml-auto">浏览：{detail.views}</span>
              </div>
              <div
                ref={contentRef}
                className="cfnote-preview prose prose-sm max-w-none mt-6"
                dangerouslySetInnerHTML={renderMd(detail.content)}
              />
              <p className="text-center text-gray-600 text-sm mt-12">· 完 ·</p>

              {/* 评论区(P11.2):仅公开文章展示;私密分享页不显示 */}
              {!detail.shared && (
                <CommentsSection articleId={detail.id} enabled={detail.comments_enabled !== false} />
              )}
            </div>
          )}
        </main>

        {/* 右侧栏 */}
        <aside className="w-[380px] shrink-0 hidden xl:block">
          <div className="bg-[var(--blog-card)] border border-[var(--blog-border)] rounded-lg overflow-hidden">
            <div className="flex items-center gap-7 px-5 pt-3 border-b border-[var(--blog-border)]">
              {(['day', 'week', 'month'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setHotRange(r)}
                  className={`pb-2.5 text-[15px] border-b-2 -mb-px transition-colors ${
                    hotRange === r
                      ? 'text-[var(--blog-title)] font-medium border-[#d43030]'
                      : 'text-[var(--blog-muted)] border-transparent hover:text-[var(--blog-text)]'
                  }`}
                >
                  {r === 'day' ? '日榜' : r === 'week' ? '周榜' : '月榜'}
                </button>
              ))}
            </div>
            <ol className="px-5 py-3">
              {hot.map((h, i) => (
                <li key={h.id}>
                  <button onClick={() => openPost(h.id)} className="w-full flex items-center gap-2.5 py-[7px] group text-left min-w-0">
                    <span
                      className={`w-[18px] h-[18px] rounded-[3px] text-[11px] font-bold text-white flex items-center justify-center shrink-0 ${
                        i < 3 ? 'bg-[#d43030]' : 'bg-[var(--blog-rank)]'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate text-sm text-[var(--blog-text)] group-hover:text-[#e05252] transition-colors">{h.title}</span>
                  </button>
                </li>
              ))}
              {hot.length === 0 && <li className="py-6 text-center text-xs text-gray-500">该时间段暂无上榜文章</li>}
            </ol>
          </div>

          {postId == null && (
            <div className="bg-[var(--blog-card)] border border-[var(--blog-border)] rounded-lg mt-5 px-5 py-4">
              <h3 className="text-[15px] font-bold text-[var(--blog-title)] border-b border-[var(--blog-border)] pb-2.5 mb-3">关于本站</h3>
              <p className="text-sm text-[var(--blog-muted)] leading-relaxed">
                这里是我的公开笔记精选,由 CFNote 个人知识库发布:笔记在编辑器中一键公开,经敏感信息检查后即刻上线。
              </p>
            </div>
          )}
        </aside>
      </div>

      {/* 回到顶部(详情页,滚过约一屏后淡入;悬浮转为主题红) */}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        aria-label="回到顶部"
        title="回到顶部"
        className={`fixed right-5 bottom-8 z-30 w-11 h-11 rounded-full bg-[var(--blog-card)] border border-[var(--blog-border)] shadow-lg flex items-center justify-center text-[var(--blog-muted)] hover:bg-[#d43030] hover:border-[#d43030] hover:text-white transition-all duration-300 ${
          showTop ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'
        }`}
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
        </svg>
      </button>

      <footer className="mt-10 bg-[#0d0d0d] py-8">
        <div className="text-center text-sm text-[#8f8f8f] space-y-1.5">
          <p>CFNote 博客 — 来自我的公开笔记</p>
          <p className="text-[#6f6f6f]">Powered by CFNote · Cloudflare Workers</p>
        </div>
      </footer>
    </div>
  )
}
