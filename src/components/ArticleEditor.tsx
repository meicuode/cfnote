import { useState, useEffect, useRef, useCallback } from 'react'
import { marked } from '../lib/markdown'
import TurndownService from 'turndown'
import type { Article } from '../types'

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

interface Props {
  article: Article
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

export default function ArticleEditor({ article, onSave, highlight, loadingContent }: Props) {
  const [title, setTitle] = useState(article.title)
  const [content, setContent] = useState(article.content)
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(true)
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
  // 加载期间编辑器只读,不存在本地修改被覆盖的问题。
  useEffect(() => {
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

  // Handle paste: convert HTML to Markdown
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
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
  }, [])

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
          <div
            ref={previewRef}
            className="cfnote-preview prose prose-sm max-w-none h-full overflow-y-auto text-gray-700"
            dangerouslySetInnerHTML={renderMarkdown()}
          />
        )}
      </div>
    </div>
  )
}
