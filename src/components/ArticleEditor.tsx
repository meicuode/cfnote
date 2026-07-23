import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { marked } from '../lib/markdown'
import TurndownService from 'turndown'
import type { Article } from '../types'

// 按需加载(jszip + simple-mind-map 体积较大,仅在点击 .xmind 附件时加载)
const XmindViewer = lazy(() => import('./XmindViewer'))

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

interface Props {
  article: Article
  token: string
  onSave: (id: number, data: { title?: string; content?: string }) => Promise<any>
  highlight?: { text: string; ts: number } | null
  loadingContent?: boolean
}

// ---- Markdown insertion helper ----

type InsertType = 'wrap' | 'line' | 'block'

interface MarkdownAction {
  type: InsertType
  prefix: string
  suffix?: string
  placeholder: string
}

const ACTIONS: Record<string, MarkdownAction> = {
  bold:      { type: 'wrap', prefix: '**', suffix: '**', placeholder: '粗体文本' },
  italic:    { type: 'wrap', prefix: '*', suffix: '*', placeholder: '斜体文本' },
  strike:    { type: 'wrap', prefix: '~~', suffix: '~~', placeholder: '删除线文本' },
  code:      { type: 'wrap', prefix: '`', suffix: '`', placeholder: '代码' },
  h1:        { type: 'line', prefix: '# ', placeholder: '标题' },
  h2:        { type: 'line', prefix: '## ', placeholder: '标题' },
  h3:        { type: 'line', prefix: '### ', placeholder: '标题' },
  ul:        { type: 'line', prefix: '- ', placeholder: '列表项' },
  ol:        { type: 'line', prefix: '1. ', placeholder: '列表项' },
  quote:     { type: 'line', prefix: '> ', placeholder: '引用文本' },
  link:      { type: 'wrap', prefix: '[', suffix: '](url)', placeholder: '链接文本' },
  codeblock: { type: 'block', prefix: '```\n', suffix: '\n```', placeholder: '代码块' },
  hr:        { type: 'block', prefix: '---', suffix: '', placeholder: '' },
}

function applyMarkdown(
  textarea: HTMLTextAreaElement,
  action: MarkdownAction,
  setContent: (v: string) => void,
) {
  const { selectionStart: start, selectionEnd: end, value } = textarea
  const selected = value.slice(start, end)
  let insert: string
  let cursorOffset: number

  if (action.type === 'wrap') {
    const text = selected || action.placeholder
    insert = `${action.prefix}${text}${action.suffix ?? ''}`
    cursorOffset = selected ? insert.length : action.prefix.length + text.length
  } else if (action.type === 'line') {
    const lineStart = value.lastIndexOf('\n', start - 1) + 1
    const text = selected || action.placeholder
    // If cursor is not at line start, insert newline first
    const needNewline = lineStart !== start && start > 0
    insert = (needNewline ? '\n' : '') + `${action.prefix}${text}`
    cursorOffset = insert.length
  } else {
    // block: insert with surrounding blank lines
    const text = selected || action.placeholder
    const before = start > 0 && value[start - 1] !== '\n' ? '\n\n' : start > 0 ? '\n' : ''
    const after = action.suffix ?? ''
    insert = `${before}${action.prefix}${text}${after}`
    cursorOffset = insert.length
  }

  const newValue = value.slice(0, start) + insert + value.slice(end)
  setContent(newValue)

  // Restore cursor position after React re-render
  requestAnimationFrame(() => {
    textarea.focus()
    const pos = start + cursorOffset
    textarea.setSelectionRange(pos, pos)
  })
}

// ---- Toolbar button definitions ----

const TOOLBAR_GROUPS = [
  [
    { key: 'bold', label: 'B', title: '加粗', className: 'font-bold' },
    { key: 'italic', label: 'I', title: '斜体', className: 'italic' },
    { key: 'strike', label: 'S', title: '删除线', className: 'line-through' },
    { key: 'code', label: '</>', title: '行内代码', className: 'font-mono text-xs' },
  ],
  [
    { key: 'h1', label: 'H1', title: '一级标题', className: 'font-bold text-xs' },
    { key: 'h2', label: 'H2', title: '二级标题', className: 'font-bold text-xs' },
    { key: 'h3', label: 'H3', title: '三级标题', className: 'font-bold text-xs' },
  ],
  [
    { key: 'ul', label: '???', title: '无序列表', className: '' },
    { key: 'ol', label: '???', title: '有序列表', className: '' },
    { key: 'quote', label: '???', title: '引用', className: '' },
  ],
  [
    { key: 'link', label: '???', title: '链接', className: '' },
    { key: 'codeblock', label: '{ }', title: '代码块', className: 'font-mono text-xs' },
    { key: 'hr', label: '???', title: '分割线', className: '' },
  ],
]

// Replace emoji placeholders with SVG icons inline
function ToolbarIcon({ k }: { k: string }) {
  const icons: Record<string, string> = {
    ul: 'M4 6h16M4 12h16M4 18h16', // list
    ol: 'M4 6h16M4 12h16M4 18h16', // same shape, differentiated by label
    quote: 'M7.5 8.25h9m-9 3H12M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    link: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    hr: 'M5 12h14',
  }
  const d = icons[k]
  if (!d) return null
  return (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  )
}

// ---- Component ----

export default function ArticleEditor({ article, token, onSave, highlight, loadingContent }: Props) {
  const [title, setTitle] = useState(article.title)
  const [content, setContent] = useState(article.content)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [xmindFile, setXmindFile] = useState<{ url: string; name: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  // 来自 AI 引用/搜索的定位请求:切到预览,滚动到匹配段落并短暂高亮
  useEffect(() => {
    if (!highlight) return
    setMode('preview')
    const t = setTimeout(() => {
      const root = previewRef.current
      if (!root) return
      const norm = (s: string) => s.replace(/[\s#*`>\-|~_[\]()（）,，。:：;；]/g, '')
      const needle = norm(highlight.text).slice(0, 24)
      if (!needle) return
      const els = root.querySelectorAll('p, li, td, th, h1, h2, h3, h4, blockquote, pre')
      for (const el of els) {
        if (norm(el.textContent || '').includes(needle)) {
          el.classList.add('cfnote-highlight')
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          setTimeout(() => el.classList.remove('cfnote-highlight'), 6000)
          break
        }
      }
    }, 150)
    return () => clearTimeout(t)
  }, [highlight?.ts, article.id])

  // 切换文章立即重置;完整正文异步到达时(loadingContent 翻转)再同步一次。
  // 草稿(id<0)首次保存后被真实文章替换,此时保留本地正在编辑的内容,不重置。
  const prevIdRef = useRef(article.id)
  useEffect(() => {
    const wasDraft = prevIdRef.current < 0 && article.id > 0
    prevIdRef.current = article.id
    if (wasDraft) return
    setTitle(article.title)
    setContent(article.content)
    setSaved(true)
  }, [article.id, loadingContent])

  useEffect(() => {
    const changed = title !== article.title || content !== article.content
    setSaved(!changed)
  }, [title, content, article.title, article.content])

  const handleSave = useCallback(async () => {
    setSaving(true)
    const res = await saveRef.current(article.id, { title, content })
    setSaving(false)
    if (res?.ok) setSaved(true)
  }, [article.id, title, content])

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (!saving && !saved) handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave, saving, saved])

  // Auto-save after 3s idle
  useEffect(() => {
    if (saved) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { handleSave() }, 3000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [handleSave, saved])

  // ---- 附件上传(R2):图片插入 ![](url),其他文件插入 [📎 name](url) ----

  const insertAtCursor = useCallback((text: string) => {
    const ta = textareaRef.current
    if (!ta) {
      setContent((prev) => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + text)
      return
    }
    const { selectionStart: start, selectionEnd: end, value } = ta
    setContent(value.slice(0, start) + text + value.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + text.length
      ta.setSelectionRange(pos, pos)
    })
  }, [])

  // XMind 客户端保存的文件内嵌 Thumbnails/thumbnail.png,上传时提取为边车文件(<key>.thumb.png)供卡片预览
  const uploadXmindThumb = useCallback(async (file: File, fileUrl: string) => {
    try {
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(file)
      const t = zip.file('Thumbnails/thumbnail.png') || zip.file('Thumbnails/thumbnail.jpg')
      if (!t) return
      await fetch(`${fileUrl}.thumb.png`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': t.name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
        },
        body: await t.async('arraybuffer'),
      })
    } catch { /* 无内嵌缩略图或上传失败:卡片降级为纯文件名 */ }
  }, [token])

  const handleUpload = useCallback(async (file: File) => {
    setUploadError('')
    setUploading(true)
    try {
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': file.type || 'application/octet-stream',
          'x-filename': encodeURIComponent(file.name),
        },
        body: file,
      })
      const j: any = await res.json()
      if (!j.ok) throw new Error(j.error || `上传失败 (${res.status})`)
      const info = j.data as { url: string; name: string; content_type: string }
      if (info.content_type.startsWith('image/')) insertAtCursor(`![${info.name}](${info.url})`)
      else insertAtCursor(`[📎 ${info.name}](${info.url})`)
      if (/\.xmind$/i.test(info.name)) uploadXmindThumb(file, info.url)
    } catch (e: any) {
      setUploadError(e.message)
      setTimeout(() => setUploadError(''), 5000)
    } finally {
      setUploading(false)
    }
  }, [token, insertAtCursor, uploadXmindThumb])

  // Handle paste: 剪贴板中的图片直接上传插入;HTML 转 Markdown
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgFile = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (imgFile) {
      e.preventDefault()
      handleUpload(imgFile)
      return
    }
    const html = e.clipboardData.getData('text/html')
    if (!html) return // plain text paste, let browser handle it
    e.preventDefault()
    const md = turndown.turndown(html)
    const ta = e.currentTarget
    const { selectionStart: start, selectionEnd: end, value } = ta
    const newValue = value.slice(0, start) + md + value.slice(end)
    setContent(newValue)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + md.length
      ta.setSelectionRange(pos, pos)
    })
  }, [handleUpload])

  const handleToolbar = (key: string) => {
    const action = ACTIONS[key]
    if (!action || !textareaRef.current) return
    applyMarkdown(textareaRef.current, action, setContent)
  }

  const renderMarkdown = () => {
    try {
      return { __html: marked(content || '', { breaks: true }) as string }
    } catch {
      return { __html: content }
    }
  }

  // 预览中把 .xmind 链接升级为缩略图卡片(边车 .thumb.png 加载失败则只剩文件名,样式降级)
  useEffect(() => {
    if (mode !== 'preview') return
    const root = previewRef.current
    if (!root) return
    for (const a of Array.from(root.querySelectorAll('a'))) {
      const href = a.getAttribute('href') || ''
      if (!/\.xmind$/i.test(href) || (a as HTMLElement).dataset.xmindCard) continue
      ;(a as HTMLElement).dataset.xmindCard = '1'
      const label = (a.textContent || 'XMind').replace(/^📎\s*/, '')
      a.classList.add('cfnote-xmind-card')
      a.textContent = ''
      const img = document.createElement('img')
      img.src = `${href}.thumb.png`
      img.loading = 'lazy'
      img.alt = ''
      img.onerror = () => img.remove()
      const span = document.createElement('span')
      span.textContent = `🧠 ${label}`
      a.appendChild(img)
      a.appendChild(span)
    }
  }, [content, mode])

  // 预览中点击 .xmind 附件链接:弹出全屏思维导图预览而非下载
  const handlePreviewClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (/\.xmind$/i.test(href)) {
      e.preventDefault()
      const rawName = href.split('/').pop() || 'mindmap.xmind'
      let fileName = rawName
      try { fileName = decodeURIComponent(rawName) } catch { /* 保留原始名 */ }
      setXmindFile({ url: href, name: fileName })
    }
  }

  // 字数(不含空白字符)与目录(H1-H4,≥2 条时预览模式显示)
  const charCount = useMemo(() => (content || '').replace(/\s/g, '').length, [content])
  const headings = useMemo(() => {
    const out: { level: number; text: string }[] = []
    let inCode = false
    for (const line of (content || '').split('\n')) {
      if (/^\s*```/.test(line)) { inCode = !inCode; continue }
      if (inCode) continue
      const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line)
      if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`~[\]]/g, '') })
    }
    return out
  }, [content])

  const scrollToHeading = (h: { level: number; text: string }) => {
    const root = previewRef.current
    if (!root) return
    const norm = (s: string) => s.replace(/\s/g, '')
    for (const el of root.querySelectorAll(`h${h.level}`)) {
      if (norm(el.textContent || '').includes(norm(h.text).slice(0, 20))) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        el.classList.add('cfnote-highlight')
        setTimeout(() => el.classList.remove('cfnote-highlight'), 2000)
        break
      }
    }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Top bar: mode toggle + save status */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode('edit')}
            className={`px-3 py-1 rounded text-sm transition-colors ${mode === 'edit' ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            编辑
          </button>
          <button
            onClick={() => setMode('preview')}
            className={`px-3 py-1 rounded text-sm transition-colors ${mode === 'preview' ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            预览
          </button>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-300">{charCount} 字</span>
          {article.is_vectorized ? (
            <span className="text-xs text-emerald-500 flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              已向量化
            </span>
          ) : null}
          <span className={`text-xs ${saved ? 'text-gray-400' : 'text-amber-500'}`}>
            {loadingContent ? '加载中...' : saving ? '保存中...' : saved ? '已保存' : '未保存'}
          </span>
          <button
            onClick={handleSave}
            disabled={saving || saved}
            className="px-3 py-1 bg-emerald-500 text-white text-sm rounded-lg hover:bg-emerald-600 disabled:opacity-40 transition-colors"
          >
            保存
          </button>
        </div>
      </div>

      {/* Markdown formatting toolbar (edit mode only) */}
      {mode === 'edit' && (
        <div className="px-4 py-1.5 border-b border-gray-100 flex items-center gap-0.5 shrink-0 overflow-x-auto">
          {TOOLBAR_GROUPS.map((group, gi) => (
            <div key={gi} className="flex items-center gap-0.5">
              {gi > 0 && <div className="w-px h-5 bg-gray-200 mx-1" />}
              {group.map(({ key, label, title, className }) => (
                <button
                  key={key}
                  title={title}
                  onClick={() => handleToolbar(key)}
                  className={`px-2 py-1 rounded text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors ${className}`}
                >
                  {['ul', 'ol', 'quote', 'link', 'hr'].includes(key) ? <ToolbarIcon k={key} /> : label}
                </button>
              ))}
            </div>
          ))}
          {/* 图片 / 附件上传 */}
          <div className="w-px h-5 bg-gray-200 mx-1" />
          <label title="插入图片(也可直接粘贴截图)" className={`px-2 py-1 rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <input type="file" accept="image/*" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleUpload(f) }} />
          </label>
          <label title="插入附件(任意文件,≤10MB)" className={`px-2 py-1 rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
            <input type="file" className="hidden" disabled={uploading}
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) handleUpload(f) }} />
          </label>
          {uploading && (
            <span className="flex items-center gap-1 text-xs text-gray-400 ml-1">
              <span className="w-3.5 h-3.5 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              上传中...
            </span>
          )}
          {uploadError && <span className="text-xs text-red-500 ml-1 truncate max-w-[240px]" title={uploadError}>{uploadError}</span>}
        </div>
      )}

      {/* Title */}
      <div className="px-6 pt-4 shrink-0">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-2xl font-bold text-gray-900 border-none outline-none bg-transparent placeholder:text-gray-300"
          placeholder="文章标题"
        />
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden px-6 py-4">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={content}
            readOnly={loadingContent}
            onChange={(e) => setContent(e.target.value)}
            onPaste={handlePaste}
            className="w-full h-full resize-none border-none outline-none text-gray-700 leading-relaxed text-[15px] font-mono bg-transparent placeholder:text-gray-300"
            placeholder="开始写作... (支持 Markdown 语法)"
          />
        ) : (
          <div className="h-full flex gap-4">
            <div
              ref={previewRef}
              className="cfnote-preview prose prose-sm max-w-none h-full overflow-y-auto text-gray-700 flex-1 min-w-0"
              onClick={handlePreviewClick}
              dangerouslySetInnerHTML={renderMarkdown()}
            />
            {/* 目录(标题 ≥2 条时显示) */}
            {headings.length >= 2 && (
              <nav className="w-44 shrink-0 hidden lg:block overflow-y-auto border-l border-gray-100 pl-3 py-1">
                <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mb-2">目录</p>
                {headings.map((h, i) => (
                  <button
                    key={`${h.text}-${i}`}
                    onClick={() => scrollToHeading(h)}
                    className="block w-full text-left text-xs text-gray-500 hover:text-emerald-600 py-1 truncate transition-colors"
                    style={{ paddingLeft: (h.level - 1) * 12 }}
                    title={h.text}
                  >
                    {h.text}
                  </button>
                ))}
              </nav>
            )}
          </div>
        )}
      </div>

      {/* XMind 全屏预览 */}
      {xmindFile && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[70] bg-white/80 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <XmindViewer url={xmindFile.url} name={xmindFile.name} token={token} onClose={() => setXmindFile(null)} />
        </Suspense>
      )}
    </div>
  )
}
