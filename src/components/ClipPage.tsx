import { useEffect, useMemo, useRef, useState } from 'react'
import TurndownService from 'turndown'
import { useAuth } from '../hooks/useAuth'
import { buildBookmarklet, CLIP_ACK, type ClipPayload } from '../lib/clip'
import type { Notebook } from '../types'

// 网页剪藏接收页(P9 #5,独立懒加载 chunk):
// - 直接打开(无 opener 载荷):显示 bookmarklet 安装引导(拖到书签栏)。
// - 由 bookmarklet 打开:收到 postMessage 载荷 → 回 ack → HTML 相对链接绝对化 →
//   turndown 转标准 Markdown(附来源行)→ 编辑标题/选笔记本 → POST /api/articles 保存。
// - 未登录时提示先去主应用登录(token 在 localStorage,同源共享)。

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
turndown.remove(['script', 'style', 'noscript', 'iframe'])

/** 相对 URL 绝对化 + 去除不可转换节点,返回清理后的 HTML */
function sanitizeHtml(html: string, baseUrl: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const abs = (el: Element, attr: string) => {
    const v = el.getAttribute(attr)
    if (!v || /^(data:|javascript:|#)/i.test(v)) return
    try {
      el.setAttribute(attr, new URL(v, baseUrl).href)
    } catch { /* 非法 URL:原样保留 */ }
  }
  doc.querySelectorAll('img').forEach((el) => {
    // 懒加载图片常把真实地址放 data-src,src 是占位(空或 data: 小图),尽力还原
    const ds = el.getAttribute('data-src') || el.getAttribute('data-original')
    const src = el.getAttribute('src') || ''
    if (ds && (!src || /^data:/i.test(src))) el.setAttribute('src', ds)
    abs(el, 'src')
    el.removeAttribute('srcset')
  })
  doc.querySelectorAll('a').forEach((el) => abs(el, 'href'))
  return doc.body.innerHTML
}

export default function ClipPage() {
  const { token } = useAuth()
  const [payload, setPayload] = useState<ClipPayload | null>(null)
  const [title, setTitle] = useState('')
  const [md, setMd] = useState('')
  const [notebooks, setNotebooks] = useState<Notebook[]>([])
  const [nbId, setNbId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedId, setSavedId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const gotPayload = useRef(false)

  const bookmarklet = useMemo(() => buildBookmarklet(window.location.origin), [])

  // 接收 bookmarklet 的载荷(轮询发送,收到即 ack)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data
      if (!d || d.type !== 'cfnote-clip' || typeof d.html !== 'string') return
      ;(e.source as Window | null)?.postMessage(CLIP_ACK, e.origin)
      if (gotPayload.current) return
      gotPayload.current = true
      setPayload(d as ClipPayload)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [])

  // 载荷到达:HTML → Markdown(绝对化链接 + 来源行)
  useEffect(() => {
    if (!payload) return
    setTitle(payload.title || '网页剪藏')
    try {
      const cleaned = sanitizeHtml(payload.html, payload.url)
      const body = turndown.turndown(cleaned).trim()
      setMd(`${body}\n\n> 剪藏自:[${payload.title || payload.url}](${payload.url})\n`)
    } catch {
      setMd(payload.html)
      setError('HTML 转换失败,已保留原始内容')
    }
  }, [payload])

  // 登录态下加载笔记本列表(默认选第一个)
  useEffect(() => {
    if (!token) return
    fetch('/api/notebooks', { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json() as Promise<any>)
      .then((j) => {
        if (j.ok && Array.isArray(j.data) && j.data.length) {
          setNotebooks(j.data)
          setNbId((cur) => cur ?? j.data[0].id)
        }
      })
      .catch(() => {})
  }, [token])

  const save = async () => {
    if (!token || !nbId || !title.trim() || saving) return
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notebook_id: nbId, title: title.trim(), content: md }),
      })
      const j = (await res.json()) as any
      if (j.ok) setSavedId(j.data.id)
      else setError(j.error || '保存失败')
    } catch {
      setError('保存失败,请检查网络后重试')
    }
    setSaving(false)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-gray-900 dark:to-gray-900 flex flex-col items-center px-4 py-8">
      <div className="w-full max-w-3xl">
        <div className="flex items-center gap-2 mb-6">
          <span className="w-9 h-9 rounded-xl bg-emerald-500 text-white flex items-center justify-center text-lg">✂️</span>
          <h1 className="text-xl font-bold text-gray-800 dark:text-gray-100">CFNote 网页剪藏</h1>
        </div>

        {!token ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-8 text-center">
            <p className="text-gray-600 dark:text-gray-300">尚未登录,剪藏需要登录态。</p>
            <a href="/" className="inline-block mt-4 px-5 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">
              去登录 CFNote →
            </a>
            <p className="text-xs text-gray-400 mt-3">登录后回到原网页重新点击书签即可。</p>
          </div>
        ) : savedId ? (
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-8 text-center">
            <p className="text-4xl mb-3">✅</p>
            <p className="text-gray-700 dark:text-gray-200 font-medium">剪藏已保存</p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <a href={`/?article=${savedId}`} className="px-5 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">
                打开笔记
              </a>
              <button onClick={() => window.close()} className="px-5 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
                关闭窗口
              </button>
            </div>
          </div>
        ) : !payload ? (
          /* 直接访问:安装引导 */
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-8">
            <h2 className="font-bold text-gray-800 dark:text-gray-100 mb-3">安装剪藏书签</h2>
            <ol className="list-decimal list-inside text-sm text-gray-600 dark:text-gray-300 space-y-2">
              <li>把下面的按钮拖到浏览器书签栏(若书签栏未显示,按 Ctrl+Shift+B)</li>
              <li>在任意网页上:选中想保存的内容(不选则抓取整页正文),点击该书签</li>
              <li>会打开本页并自动转换为 Markdown,确认后保存为笔记</li>
            </ol>
            <div className="mt-5 flex items-center gap-4">
              <a
                // React 19 会拦截 href 里的 javascript: URL(安全策略),故不经 prop、
                // 用 ref 原生 setAttribute 直接写入,浏览器才能拿到真正可拖拽的 bookmarklet
                ref={(el) => { if (el) el.setAttribute('href', bookmarklet) }}
                onClick={(e) => e.preventDefault()}
                title="按住拖到书签栏"
                className="px-5 py-2.5 rounded-lg bg-emerald-500 text-white font-medium cursor-grab select-none shadow hover:bg-emerald-600"
              >
                ✂️ 剪藏到 CFNote
              </a>
              <span className="text-xs text-gray-400">← 按住拖到书签栏(点击无效)</span>
            </div>
            <div className="mt-3">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(bookmarklet)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 2000)
                  } catch { setError('复制失败,请手动选中下方代码复制') }
                }}
                className="text-xs text-emerald-600 hover:underline"
              >
                {copied ? '已复制 ✓' : '拖不动?点这里复制书签代码'}
              </button>
              <p className="text-[11px] text-gray-400 mt-1">
                手动安装:新建一个书签 → 名称随意 → <b>网址(URL)</b>粘贴刚复制的代码保存即可。
              </p>
            </div>
            <p className="text-xs text-gray-400 mt-5">
              提示:部分站点的 CSP 会拦截书签脚本(如 GitHub),此类页面请手动复制内容粘贴进编辑器(粘贴自带 HTML→Markdown 转换)。
            </p>
          </div>
        ) : (
          /* 收到载荷:编辑并保存 */
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow p-6 space-y-4">
            <div className="flex items-center gap-3">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="笔记标题"
                className="flex-1 px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              />
              <select
                value={nbId ?? ''}
                onChange={(e) => setNbId(Number(e.target.value))}
                className="px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-sm max-w-[180px]"
              >
                {notebooks.map((n) => (
                  <option key={n.id} value={n.id}>{n.name}</option>
                ))}
              </select>
            </div>
            <p className="text-xs text-gray-400 truncate">来源:{payload.url}</p>
            <textarea
              value={md}
              onChange={(e) => setMd(e.target.value)}
              spellCheck={false}
              className="w-full h-[50vh] px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-transparent text-sm font-mono text-gray-700 dark:text-gray-200 resize-y focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            {error && <p className="text-sm text-red-500">{error}</p>}
            <div className="flex items-center justify-end gap-3">
              <button onClick={() => window.close()} className="px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 text-sm hover:bg-gray-50 dark:hover:bg-gray-700">
                取消
              </button>
              <button
                onClick={save}
                disabled={saving || !title.trim() || !nbId}
                className="px-5 py-2 rounded-lg bg-emerald-500 text-white text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
              >
                {saving ? '保存中…' : '保存为笔记'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
