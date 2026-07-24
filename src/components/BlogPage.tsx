import { useEffect, useState } from 'react'
import { marked } from '../lib/markdown'

// 公开博客页(IT之家风格深色布局,见 docs/public-blog.md):
// 免登录,数据来自 /api/blog/*(仅公开且非私有的笔记)。/blog 列表,/blog/:id 详情,pushState 路由。

interface BlogPost {
  id: number
  title: string
  tag: string
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
  published_at: string
  views: number
}

interface HotItem {
  id: number
  title: string
  views: number
}

const parsePath = (): number | null => {
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

export default function BlogPage() {
  const [postId, setPostId] = useState<number | null>(parsePath())
  const [posts, setPosts] = useState<BlogPost[] | null>(null)
  const [detail, setDetail] = useState<BlogDetail | null>(null)
  const [detailErr, setDetailErr] = useState('')
  const [hot, setHot] = useState<HotItem[]>([])
  const [hotRange, setHotRange] = useState<'day' | 'week' | 'month'>('day')

  useEffect(() => {
    const onPop = () => setPostId(parsePath())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

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
    fetch(`/api/blog/posts/${postId}`)
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

  const openPost = (id: number) => {
    window.history.pushState(null, '', `/blog/${id}`)
    setPostId(id)
  }
  const goHome = () => {
    window.history.pushState(null, '', '/blog')
    setPostId(null)
  }

  return (
    <div className="dark cfnote-blog min-h-screen bg-[#262626] flex flex-col">
      {/* 顶栏 */}
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
              postId == null ? 'text-white border-[#d43030] font-medium' : 'text-gray-300 border-transparent hover:text-white'
            }`}
          >
            首页
          </button>
          <a href="/" className="ml-auto text-sm text-gray-300 hover:text-white transition-colors">
            进入笔记本 →
          </a>
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
                  className="flex gap-5 py-6 border-b border-white/[0.06] cursor-pointer group"
                >
                  {p.thumb ? (
                    <img
                      src={p.thumb}
                      alt=""
                      loading="lazy"
                      className="w-[130px] h-[80px] sm:w-[215px] sm:h-[125px] object-cover rounded-md bg-black/30 shrink-0"
                    />
                  ) : (
                    <div className="w-[130px] h-[80px] sm:w-[215px] sm:h-[125px] rounded-md shrink-0 bg-gradient-to-br from-[#383838] to-[#2a2a2a] flex flex-col items-center justify-center gap-1">
                      <span className="text-2xl">📝</span>
                      <span className="text-xs text-gray-500 hidden sm:block">CFNote</span>
                    </div>
                  )}
                  <div className="flex-1 min-w-0 flex flex-col py-0.5">
                    <h2 className="text-base sm:text-[19px] font-bold leading-snug text-gray-100 group-hover:text-[#e05252] transition-colors line-clamp-2">
                      {p.title}
                    </h2>
                    {p.excerpt && <p className="text-sm text-[#999] mt-2.5 leading-relaxed line-clamp-2 hidden sm:block">{p.excerpt}</p>}
                    <div className="mt-auto pt-3 flex items-center text-sm min-w-0">
                      <span className="text-[#8f8f8f] truncate">Tags：{p.tag}</span>
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
                <button onClick={goHome} className="text-gray-400 hover:text-[#e05252] transition-colors">
                  首页
                </button>
                <span className="text-gray-600">&gt;</span>
                <span className="text-gray-400">{detail.tag}</span>
              </div>
              <h1 className="text-[26px] sm:text-[28px] font-bold leading-snug text-gray-100 mt-5">{detail.title}</h1>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-gray-500 mt-4">
                <span>{fmtFull(detail.published_at)}</span>
                <span>来源：CFNote 笔记</span>
                <span>Tags：{detail.tag}</span>
                <span className="ml-auto">浏览：{detail.views}</span>
              </div>
              <div
                className="cfnote-preview prose prose-sm max-w-none mt-6"
                dangerouslySetInnerHTML={renderMd(detail.content)}
              />
              <p className="text-center text-gray-600 text-sm mt-12">· 完 ·</p>

              {/* 评论区(个人博客暂不开放,保留版式) */}
              <section className="mt-10 mb-4">
                <div className="flex items-end justify-between border-b-2 border-[#d43030] pb-2">
                  <h3 className="text-xl font-bold text-gray-100">评论</h3>
                  <span className="text-xs text-gray-500 hidden sm:block">愿每一段记录,都有回响。</span>
                </div>
                <div className="bg-[#0d0d0d] rounded mt-4 py-5 text-center text-sm text-gray-400">
                  本博客为个人笔记博客,暂未开放评论
                </div>
              </section>
            </div>
          )}
        </main>

        {/* 右侧栏 */}
        <aside className="w-[380px] shrink-0 hidden xl:block">
          <div className="bg-[#2f2f2f] rounded-lg overflow-hidden">
            <div className="flex items-center gap-7 px-5 pt-3 border-b border-white/[0.08]">
              {(['day', 'week', 'month'] as const).map((r) => (
                <button
                  key={r}
                  onClick={() => setHotRange(r)}
                  className={`pb-2.5 text-[15px] border-b-2 -mb-px transition-colors ${
                    hotRange === r ? 'text-white font-medium border-[#d43030]' : 'text-gray-400 border-transparent hover:text-gray-200'
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
                        i < 3 ? 'bg-[#d43030]' : 'bg-[#4a4a4a]'
                      }`}
                    >
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate text-sm text-gray-300 group-hover:text-[#e05252] transition-colors">{h.title}</span>
                  </button>
                </li>
              ))}
              {hot.length === 0 && <li className="py-6 text-center text-xs text-gray-500">该时间段暂无上榜文章</li>}
            </ol>
          </div>

          {postId == null && (
            <div className="bg-[#2f2f2f] rounded-lg mt-5 px-5 py-4">
              <h3 className="text-[15px] font-bold text-white border-b border-white/[0.08] pb-2.5 mb-3">关于本站</h3>
              <p className="text-sm text-gray-400 leading-relaxed">
                这里是我的公开笔记精选,由 CFNote 个人知识库发布:笔记在编辑器中一键公开,经敏感信息检查后即刻上线。
              </p>
            </div>
          )}
        </aside>
      </div>

      <footer className="mt-10 bg-[#0d0d0d] py-8">
        <div className="text-center text-sm text-gray-500 space-y-1.5">
          <p>CFNote 博客 — 来自我的公开笔记</p>
          <p className="text-gray-600">Powered by CFNote · Cloudflare Workers</p>
        </div>
      </footer>
    </div>
  )
}
