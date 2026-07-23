import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { marked } from '../lib/markdown'
import { formatBytes, formatDateTime } from '../lib/format'
import { setImageWidth } from '../lib/imageResize'
import TurndownService from 'turndown'
import type { Article } from '../types'

// 按需加载(jszip + simple-mind-map 体积较大,仅在点击 .xmind 附件时加载)
const XmindViewer = lazy(() => import('./XmindViewer'))
// 按需加载(TipTap 体积较大,仅在进入富文本模式时加载)
const WysiwygEditor = lazy(() => import('./WysiwygEditor'))

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
  const [mode, setMode] = useState<'edit' | 'wysiwyg' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [xmindFile, setXmindFile] = useState<{ url: string; name: string } | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const xmindSavedRef = useRef(false) // 查看器内是否保存过(决定关闭时是否刷新缩略图)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const wysiwygWrapRef = useRef<HTMLDivElement>(null)

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

  // XMind 客户端保存的文件内嵌 Thumbnails/thumbnail.png,上传时提取并降采样为边车文件(<key>.thumb.png)供卡片预览。
  // 只处理边车展示用图,不改动 .xmind 原文件字节。
  const uploadXmindThumb = useCallback(async (file: File, fileUrl: string) => {
    try {
      const [{ default: JSZip }, { downscaleToPng, THUMB_MAX_BYTES }] = await Promise.all([
        import('jszip'),
        import('../lib/thumbnail'),
      ])
      const zip = await JSZip.loadAsync(file)
      const t = zip.file('Thumbnails/thumbnail.png') || zip.file('Thumbnails/thumbnail.jpg')
      if (!t) return
      const raw = await t.async('blob')
      let bytes = await downscaleToPng(raw, 480)
      let mime = 'image/png'
      if (!bytes && raw.size <= THUMB_MAX_BYTES) {
        bytes = new Uint8Array(await raw.arrayBuffer())
        mime = t.name.endsWith('.jpg') ? 'image/jpeg' : 'image/png'
      }
      if (!bytes || bytes.length > THUMB_MAX_BYTES) return
      await fetch(`${fileUrl}.thumb.png`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': mime },
        body: bytes as unknown as BodyInit,
      })
    } catch { /* 无内嵌缩略图或上传失败:卡片降级为纯文件名 */ }
  }, [token])

  // 上传核心:POST /api/files,失败抛错(错误文案与限额由服务端统一);xmind 附带提取边车缩略图。
  // 源码模式与富文本模式共用,保证 10MB 限制与错误提示完全一致。
  const uploadFileRaw = useCallback(async (file: File) => {
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
    if (/\.xmind$/i.test(info.name)) uploadXmindThumb(file, info.url)
    return info
  }, [token, uploadXmindThumb])

  const handleUpload = useCallback(async (file: File) => {
    setUploadError('')
    setUploading(true)
    try {
      const info = await uploadFileRaw(file)
      if (info.content_type.startsWith('image/')) insertAtCursor(`![${info.name}](${info.url})`)
      else insertAtCursor(`[📎 ${info.name}](${info.url})`)
    } catch (e: any) {
      setUploadError(e.message)
      setTimeout(() => setUploadError(''), 5000)
    } finally {
      setUploading(false)
    }
  }, [uploadFileRaw, insertAtCursor])

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

  // 把预览里的 .xmind 链接升级为卡片:有缩略图显示缩略图,没有则显示固定尺寸占位图;
  // 悬浮显示大小/创建/修改时间(HEAD 元信息,失败静默)。幂等,可反复调用。
  const upgradeXmindCards = useCallback(() => {
    const root = previewRef.current
    if (!root) return
    for (const a of Array.from(root.querySelectorAll('a'))) {
      const href = a.getAttribute('href') || ''
      if (!/\.xmind$/i.test(href) || (a as HTMLElement).dataset.xmindCard) continue
      const el = a as HTMLElement
      el.dataset.xmindCard = '1'
      const label = el.dataset.xmindLabel || (a.textContent || 'XMind').replace(/^📎\s*/, '')
      el.dataset.xmindLabel = label
      a.classList.add('cfnote-xmind-card')
      a.textContent = ''
      const img = document.createElement('img')
      // thumbV:xmind 编辑保存后设置,绕过缩略图的 immutable 强缓存取新图
      img.src = `${href}.thumb.png${el.dataset.thumbV ? `?v=${el.dataset.thumbV}` : ''}`
      img.loading = 'lazy'
      img.alt = ''
      img.onerror = () => {
        const ph = document.createElement('div')
        ph.className = 'cfnote-xmind-placeholder'
        ph.innerHTML = '<em>🧠</em><b>XMind 思维导图</b>'
        img.replaceWith(ph)
      }
      const span = document.createElement('span')
      span.textContent = `🧠 ${label}`
      a.appendChild(img)
      a.appendChild(span)
      fetch(href, { method: 'HEAD' })
        .then((r) => {
          if (!r.ok) return
          const size = Number(r.headers.get('content-length'))
          const created = r.headers.get('x-created')
          const modified = r.headers.get('last-modified')
          if (size > 0 && span.isConnected) span.textContent = `🧠 ${label} · ${formatBytes(size)}`
          a.title = [
            label,
            size > 0 ? `大小：${formatBytes(size)}` : '',
            created ? `创建：${formatDateTime(created)}` : '',
            modified ? `修改：${formatDateTime(modified)}` : '',
          ].filter(Boolean).join('\n')
        })
        .catch(() => {})
    }
  }, [])

  // 给预览里的图片(xmind 卡片除外)加右下角拖拽手柄:拖动即调整显示宽度,
  // 松手后把源文对应图片改写为标准 <img width>(逻辑与测试见 src/lib/imageResize.ts)。幂等。
  const upgradeImageResize = useCallback(() => {
    const root = previewRef.current
    if (!root) return
    for (const img of Array.from(root.querySelectorAll('img'))) {
      if (img.closest('a.cfnote-xmind-card') || (img as HTMLElement).dataset.resz) continue
      ;(img as HTMLElement).dataset.resz = '1'
      const wrap = document.createElement('span')
      wrap.className = 'cfnote-img-wrap'
      img.replaceWith(wrap)
      wrap.appendChild(img)
      const handle = document.createElement('b')
      handle.className = 'cfnote-img-handle'
      handle.title = '拖拽调整宽度'
      wrap.appendChild(handle)
      // 手柄可能位于链接内:吞掉 click,避免拖拽后触发跳转/lightbox
      handle.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation() })
      handle.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        const startX = ev.clientX
        const startW = img.getBoundingClientRect().width
        const maxW = Math.max(120, root.clientWidth - 32)
        let lastW = Math.round(startW)
        const move = (e: MouseEvent) => {
          lastW = Math.round(Math.min(maxW, Math.max(80, startW + e.clientX - startX)))
          img.style.width = `${lastW}px`
          img.style.height = 'auto'
        }
        const up = () => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          if (Math.abs(lastW - startW) < 4) return
          const src = img.getAttribute('src') || ''
          const peers = Array.from(root.querySelectorAll('img'))
            .filter((i) => !i.closest('a.cfnote-xmind-card') && i.getAttribute('src') === src)
          const nth = peers.indexOf(img)
          setContent((prev) => setImageWidth(prev, src, nth, lastW) ?? prev)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      })
    }
  }, [])

  // 预览 DOM 任何变化(含 React 重设 innerHTML)后都重建卡片与图片手柄,避免注入的增强被冲掉
  useEffect(() => {
    if (mode !== 'preview') return
    const upgrade = () => { upgradeXmindCards(); upgradeImageResize() }
    upgrade()
    const root = previewRef.current
    if (!root) return
    const mo = new MutationObserver(upgrade)
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [content, mode, upgradeXmindCards, upgradeImageResize])

  // Esc 关闭图片放大预览
  useEffect(() => {
    if (!lightbox) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lightbox])

  // 预览点击:图片弹出放大预览;.xmind 附件链接弹出思维导图查看器(而非下载)
  const handlePreviewClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'IMG' && !target.closest('a.cfnote-xmind-card')) {
      e.preventDefault()
      setLightbox((target as HTMLImageElement).src)
      return
    }
    const a = target.closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (/\.xmind$/i.test(href)) {
      e.preventDefault()
      const rawName = href.split('/').pop() || 'mindmap.xmind'
      let fileName = rawName
      try { fileName = decodeURIComponent(rawName) } catch { /* 保留原始名 */ }
      xmindSavedRef.current = false
      setXmindFile({ url: href, name: fileName })
    }
  }

  // 关闭 xmind 查看器:若期间保存过,给对应卡片打上版本号重建,取到最新缩略图
  const closeXmind = useCallback(() => {
    const saved = xmindSavedRef.current
    const href = xmindFile?.url
    setXmindFile(null)
    if (!saved || !href) return
    const root = previewRef.current
    if (!root) return
    for (const a of Array.from(root.querySelectorAll('a[data-xmind-card]'))) {
      if ((a.getAttribute('href') || '') !== href) continue
      const el = a as HTMLElement
      el.dataset.thumbV = String(Date.now())
      delete el.dataset.xmindCard
      a.textContent = `📎 ${el.dataset.xmindLabel || 'XMind'}`
    }
    upgradeXmindCards()
  }, [xmindFile, upgradeXmindCards])

  // 预览双击任意段落:切到编辑模式,并把光标定位到对应的源文位置(按文本前缀匹配,逐级降长兜底)
  const handlePreviewDblClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'IMG' || target.closest('a.cfnote-xmind-card')) return
    const block = target.closest('p,h1,h2,h3,h4,h5,h6,li,pre,blockquote,td,th') as HTMLElement | null
    const text = (block?.textContent || '').trim()
    let idx = -1
    for (const len of [40, 20, 10, 4]) {
      const probe = text.slice(0, len).trim()
      if (probe.length < 2) continue
      idx = content.indexOf(probe)
      if (idx >= 0) break
    }
    setMode('edit')
    setTimeout(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const pos = idx >= 0 ? idx : ta.value.length
      ta.setSelectionRange(pos, pos)
      const line = ta.value.slice(0, pos).split('\n').length
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 24
      ta.scrollTop = Math.max(0, (line - 3) * lh)
    }, 0)
  }

  // 编辑模式点击文末之后的空白区域:自动补足换行,让光标落在点击的位置(免去连按回车)
  const handleTextareaClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget
    if (loadingContent) return
    // 浏览器把"点在内容之后"的光标置于末尾;光标不在末尾说明点在内容中间,不处理
    if (ta.selectionStart !== ta.value.length || ta.selectionEnd !== ta.value.length) return
    const style = getComputedStyle(ta)
    const lh = parseFloat(style.lineHeight) || 24
    const padTop = parseFloat(style.paddingTop) || 0
    const clickY = e.clientY - ta.getBoundingClientRect().top + ta.scrollTop
    // 按换行数估算内容底部;长行折行时会低估 → 只会少补行,不会多补
    const lines = ta.value ? ta.value.split('\n').length : 1
    const contentBottom = padTop + lines * lh
    const extra = Math.floor((clickY - contentBottom) / lh)
    if (extra <= 0) return
    const pad = '\n'.repeat(extra + (ta.value && !ta.value.endsWith('\n') ? 1 : 0))
    const next = ta.value + pad
    setContent(next)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
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
    const root = mode === 'preview' ? previewRef.current : wysiwygWrapRef.current
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

  // 目录(预览与富文本模式共用)
  const tocNav = headings.length >= 2 ? (
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
  ) : null

  return (
    <div className="h-full flex flex-col">
      {/* Top bar: mode toggle + save status */}
      <div className="px-4 py-2 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setMode('edit')}
            className={`px-3 py-1 rounded text-sm transition-colors ${mode === 'edit' ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            源码
          </button>
          <button
            onClick={() => setMode('wysiwyg')}
            className={`px-3 py-1 rounded text-sm transition-colors ${mode === 'wysiwyg' ? 'bg-gray-200 text-gray-800' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            富文本
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
            onClick={handleTextareaClick}
            className="w-full h-full resize-none border-none outline-none text-gray-700 leading-relaxed text-[15px] font-mono bg-transparent placeholder:text-gray-300"
            placeholder="开始写作... (支持 Markdown 语法)"
          />
        ) : mode === 'wysiwyg' ? (
          <div ref={wysiwygWrapRef} className="h-full flex gap-4">
            <div className="flex-1 min-w-0 h-full">
              <Suspense
                fallback={
                  <div className="h-full flex items-center justify-center">
                    <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                  </div>
                }
              >
                <WysiwygEditor
                  value={content}
                  onChange={setContent}
                  readOnly={loadingContent}
                  onUploadFile={uploadFileRaw}
                  onPatchContent={(fn) => setContent((prev) => fn(prev))}
                  onImagePreview={setLightbox}
                />
              </Suspense>
            </div>
            {tocNav}
          </div>
        ) : (
          <div className="h-full flex gap-4">
            <div
              ref={previewRef}
              className="cfnote-preview prose prose-sm max-w-none h-full overflow-y-auto text-gray-700 flex-1 min-w-0"
              onClick={handlePreviewClick}
              onDoubleClick={handlePreviewDblClick}
              dangerouslySetInnerHTML={renderMarkdown()}
            />
            {tocNav}
          </div>
        )}
      </div>

      {/* XMind 弹窗预览 */}
      {xmindFile && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[70] bg-white/80 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <XmindViewer
            url={xmindFile.url}
            name={xmindFile.name}
            token={token}
            onClose={closeXmind}
            onSaved={() => { xmindSavedRef.current = true }}
          />
        </Suspense>
      )}

      {/* 图片放大预览 */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            className="max-w-[92vw] max-h-[92vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
            alt="图片预览"
          />
          <button className="absolute top-4 right-4 text-white/80 hover:text-white p-2" onClick={() => setLightbox(null)}>
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
