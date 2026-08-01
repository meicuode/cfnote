import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react'
import { marked } from '../lib/markdown'
import { formatBytes, formatDateTime } from '../lib/format'
import { setImageWidth } from '../lib/imageResize'
import TurndownService from 'turndown'
import { sourceModePasteText } from '../lib/pasteDetect'
import { scanSensitive, type SensitiveHit } from '../lib/sensitiveScan'
import ConfirmDialog from './ConfirmDialog'
import { parseTags } from '../types'
import { toggleTaskItem, enableTaskCheckboxes } from '../lib/markdownTasks'
import { enhanceRendered } from '../lib/renderEnhance'
import { EXPIRY_PRESETS, fmtRemaining } from '../lib/fmUtils'
import { formatRemindTime } from '../lib/reminders'
import type { Article } from '../types'

// 按需加载(jszip + simple-mind-map 体积较大,仅在点击 .xmind 附件时加载)
const XmindViewer = lazy(() => import('./XmindViewer'))
// 按需加载(TipTap 体积较大,仅在进入富文本模式时加载)
const WysiwygEditor = lazy(() => import('./WysiwygEditor'))
// 按需加载(P8.3 文件库选择器:双 Tab 上传/选库,源码与富文本共用)
const FilePickerDialog = lazy(() => import('./FilePickerDialog'))
import type { PickedFile } from './FilePickerDialog'
// 按需加载(P9.2 笔记链接选择器,源码与富文本共用)
const NoteLinkDialog = lazy(() => import('./NoteLinkDialog'))
import type { NoteLinkItem } from './NoteLinkDialog'
// 按需加载(P10 版本历史对话框)
const VersionHistoryDialog = lazy(() => import('./VersionHistoryDialog'))

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

interface Props {
  article: Article
  token: string
  onSave: (id: number, data: { title?: string; content?: string; is_public?: number; is_private?: number; tags?: string[] }) => Promise<any>
  highlight?: { text: string; ts: number } | null
  loadingContent?: boolean
  /** 已有标签全集(P9,标签输入的 datalist 补全) */
  allTags?: string[]
  /** 应用内打开另一篇笔记(P9.2 笔记链接/反向链接点击) */
  onOpenArticle?: (id: number) => void
  /** P10 提醒变更后通知外层刷新铃铛(设置/清除提醒时) */
  onRemindersChanged?: () => void
}

// 私有标识(eye-off:斜杠划掉的眼睛,表示不可对外展示)
export function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.878 9.878L6.59 6.59m7.532 7.532l3.29 3.29M3 3l18 18"
      />
    </svg>
  )
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

// 移动端(触屏手机/平板)富文本降级只读:ProseMirror 在移动端 IME 下编辑不可靠,编辑走源码模式。
// iPadOS 桌面化 UA 伪装为 Macintosh,以多触点辅助识别。
const IS_MOBILE = typeof navigator !== 'undefined' &&
  (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1))

// ---- Component ----

export default function ArticleEditor({ article, token, onSave, highlight, loadingContent, allTags, onOpenArticle, onRemindersChanged }: Props) {
  const [title, setTitle] = useState(article.title)
  const [content, setContent] = useState(article.content)
  // P9 标签(chips 编辑,随保存提交)与回收站只读态
  const [tags, setTags] = useState<string[]>(parseTags(article.tags))
  const [tagInput, setTagInput] = useState('')
  const trashed = !!article.deleted_at
  // P9.2 笔记间链接:选择器 + 反向链接(哪些笔记链接到本篇)
  const [showNoteLink, setShowNoteLink] = useState(false)
  const [backlinks, setBacklinks] = useState<{ id: number; title: string }[]>([])
  // P9.3 私密分享:本地覆盖态(分享/取消后即时生效,下次保存由文章数据接管)
  const [shareDialog, setShareDialog] = useState(false)
  const [sharePreset, setSharePreset] = useState<number | null>(604800)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareOverride, setShareOverride] = useState<{ token: string | null; expires: string | null } | null>(null)
  const share = shareOverride ?? { token: article.share_token ?? null, expires: article.share_expires_at ?? null }
  // 移动端默认进预览(P15.1):手机上多数时候是「看」,一进来就是等宽字体的源码没有意义。
  // 要写就点「源码」——textarea 在移动端是可用的,只有富文本不行(见 IS_MOBILE 注释)。
  const [mode, setMode] = useState<'edit' | 'wysiwyg' | 'preview'>(IS_MOBILE ? 'preview' : 'edit')
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
  const modeRef = useRef(mode)
  modeRef.current = mode

  // 来自 AI 引用/搜索的定位请求:富文本模式内直接定位(不打断编辑),其余模式切到预览定位
  useEffect(() => {
    if (!highlight) return
    const inWysiwyg = modeRef.current === 'wysiwyg'
    if (!inWysiwyg) setMode('preview')
    const t = setTimeout(() => {
      const root = inWysiwyg
        ? ((wysiwygWrapRef.current?.querySelector('.cfnote-wysiwyg-content') || null) as HTMLElement | null)
        : previewRef.current
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
    setTags(parseTags(article.tags))
    setTagInput('')
    setShareOverride(null)
    setSaved(true)
  }, [article.id, loadingContent])

  useEffect(() => {
    const changed = title !== article.title || content !== article.content
      || JSON.stringify(tags) !== JSON.stringify(parseTags(article.tags))
    setSaved(!changed)
  }, [title, content, tags, article.title, article.content, article.tags])

  // P9.2 反向链接:打开文章时查一次(其他笔记内容变化才会影响,不随本篇编辑刷新)
  useEffect(() => {
    setBacklinks([])
    if (article.id <= 0) return
    let alive = true
    fetch(`/api/articles/${article.id}/backlinks`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json() as Promise<any>)
      .then((j) => { if (alive && j?.ok) setBacklinks(j.data || []) })
      .catch(() => {})
    return () => { alive = false }
  }, [article.id, token])

  const handleSave = useCallback(async () => {
    setSaving(true)
    const res = await saveRef.current(article.id, { title, content, tags })
    setSaving(false)
    if (res?.ok) setSaved(true)
  }, [article.id, title, content, tags])

  // P10 版本历史:恢复=把选中版本作为当前工作副本并立即落库(既有保存链路会再快照一版)
  const [showVersions, setShowVersions] = useState(false)
  const restoreVersion = useCallback(async (v: { title: string; content: string; tags: string[] }) => {
    setTitle(v.title)
    setContent(v.content)
    setTags(v.tags)
    setSaving(true)
    const res = await saveRef.current(article.id, { title: v.title, content: v.content, tags: v.tags })
    setSaving(false)
    if (res?.ok) setSaved(true)
  }, [article.id])

  // P10 提醒:remindOverride 为本地覆盖(undefined=沿用 article.remind_at),切换文章时重置
  const [showRemind, setShowRemind] = useState(false)
  const [remindBusy, setRemindBusy] = useState(false)
  const [remindOverride, setRemindOverride] = useState<string | null | undefined>(undefined)
  useEffect(() => { setRemindOverride(undefined); setShowRemind(false) }, [article.id])
  const remindAt = remindOverride !== undefined ? remindOverride : (article.remind_at ?? null)
  const setReminder = async (iso: string | null) => {
    setRemindBusy(true)
    try {
      const res = await fetch(`/api/articles/${article.id}/reminder`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ remind_at: iso }),
      })
      const j = (await res.json()) as any
      if (j.ok) {
        setRemindOverride(j.data.remind_at ?? null)
        onRemindersChanged?.()
        setShowRemind(false)
      }
    } finally {
      setRemindBusy(false)
    }
  }
  // 预设时间(本地):今晚 20:00、明天 09:00、下周同一时刻;转 ISO UTC 提交
  const remindPresets = (): { label: string; iso: string }[] => {
    const mk = (d: Date) => d.toISOString()
    const now = new Date()
    const tonight = new Date(now); tonight.setHours(20, 0, 0, 0)
    const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1); tomorrow.setHours(9, 0, 0, 0)
    const nextWeek = new Date(now); nextWeek.setDate(now.getDate() + 7); nextWeek.setHours(9, 0, 0, 0)
    const out: { label: string; iso: string }[] = []
    if (tonight.getTime() > now.getTime()) out.push({ label: '今晚 20:00', iso: mk(tonight) })
    out.push({ label: '明天 09:00', iso: mk(tomorrow) })
    out.push({ label: '下周 09:00', iso: mk(nextWeek) })
    return out
  }

  // ---- 公开 / 私有(公开博客,详见 docs/public-blog.md)----
  const isPublic = !!article.is_public
  const isPrivate = !!article.is_private
  // 发布前附件清单(/api/fm/refcheck):files 为 null 表示检查中;
  // private_file 表示附件在私密文件夹内——不随笔记公开,访客不可见
  interface RefFile {
    key: string; name: string; url: string; size: number; category: string
    thumb: string | null
    private_file: boolean
    other_refs: { id: number; title: string; is_public: boolean; is_private: boolean }[]
  }
  const [publishDialog, setPublishDialog] = useState<{ risks: SensitiveHit[]; files: RefFile[] | null } | null>(null)
  const [flagConfirm, setFlagConfirm] = useState<'private' | 'unprivate' | 'unpublish' | null>(null)
  const [flagBusy, setFlagBusy] = useState(false)

  // 切换公开/私有时连同当前编辑内容一并保存:保证博客展示的就是眼前这份
  const applyFlags = async (flags: { is_public?: number; is_private?: number }) => {
    setFlagBusy(true)
    try {
      await saveRef.current(article.id, { title, content, ...flags })
    } finally {
      setFlagBusy(false)
      setPublishDialog(null)
    }
  }

  // 点击公开:文本走敏感信息全文扫描,附件走服务端引用检查(清单+私有交叉引用警告)
  const handlePublishClick = () => {    setPublishDialog({ risks: scanSensitive(`${title}\n${content}`), files: null })
    fetch('/api/fm/refcheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content, article_id: article.id }),
    })
      .then((r) => r.json() as Promise<any>)
      .then((j) => setPublishDialog((prev) => (prev ? { ...prev, files: j.ok ? j.data.files : [] } : prev)))
      .catch(() => setPublishDialog((prev) => (prev ? { ...prev, files: [] } : prev)))
  }

  // ---- P9.3 私密分享 ----
  const [shareErr, setShareErr] = useState('')

  const copyShareLink = async (tokenStr: string) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/blog/share/${tokenStr}`)
      return true
    } catch {
      return false
    }
  }

  const submitShare = async () => {
    if (shareBusy || article.id <= 0) return
    setShareBusy(true)
    setShareErr('')
    try {
      const res = await fetch(`/api/articles/${article.id}/share`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ expires_in: sharePreset }),
      })
      const j: any = await res.json()
      if (!j?.ok) {
        setShareErr(j?.error || '分享失败')
        return
      }
      setShareOverride({ token: j.data.token, expires: j.data.share_expires_at })
      await copyShareLink(j.data.token)
    } catch (e: any) {
      setShareErr(e?.message || '分享失败')
    } finally {
      setShareBusy(false)
    }
  }

  const cancelShare = async () => {
    try {
      const res = await fetch(`/api/articles/${article.id}/share`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      })
      const j: any = await res.json()
      if (j?.ok) setShareOverride({ token: null, expires: null })
      else setShareErr(j?.error || '取消失败')
    } catch (e: any) {
      setShareErr(e?.message || '取消失败')
    }
  }

  // Ctrl+S / Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        if (!saving && !saved && !trashed) handleSave()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [handleSave, saving, saved, trashed])

  // Auto-save after 3s idle
  useEffect(() => {
    if (saved || trashed) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { handleSave() }, 3000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [handleSave, saved, trashed])

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

  // ---- P8.3 文件库选择器(源码模式):选中插入既有 URL;上传 Tab 逐个走现有上传管线 ----
  const [showFilePicker, setShowFilePicker] = useState(false)

  const insertPicked = useCallback((f: PickedFile) => {
    if (f.category === 'image') insertAtCursor(`![${f.name}](${f.url})`)
    else insertAtCursor(`[📎 ${f.name}](${f.url})`)
  }, [insertAtCursor])

  const uploadPicked = useCallback((fs: File[]) => {
    void (async () => { for (const f of fs) await handleUpload(f) })()
  }, [handleUpload])

  // Handle paste: 剪贴板中的图片直接上传插入;先判定剪贴板本质(src/lib/pasteDetect.ts):
  // Markdown/代码源文(VS Code、AI 代码块等的高亮 HTML)原样插入纯文本,避免 turndown 转义;
  // 真正的网页富文本才走 HTML → Markdown
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imgFile = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'))
    if (imgFile) {
      e.preventDefault()
      handleUpload(imgFile)
      return
    }
    if (!e.clipboardData.getData('text/html')) return // 纯文本粘贴走浏览器默认
    const snippet = sourceModePasteText(
      {
        html: e.clipboardData.getData('text/html'),
        text: e.clipboardData.getData('text/plain'),
        vscodeMeta: e.clipboardData.getData('vscode-editor-data'),
      },
      (h) => turndown.turndown(h),
    )
    if (snippet == null) return
    e.preventDefault()
    const ta = e.currentTarget
    const { selectionStart: start, selectionEnd: end, value } = ta
    const newValue = value.slice(0, start) + snippet + value.slice(end)
    setContent(newValue)
    requestAnimationFrame(() => {
      ta.focus()
      const pos = start + snippet.length
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
      // 任务复选框去 disabled,预览中可点击勾选(handlePreviewClick 回写源文)
      return { __html: enableTaskCheckboxes(marked(content || '', { breaks: true }) as string) }
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
    const upgrade = () => { upgradeXmindCards(); upgradeImageResize(); enhanceRendered(previewRef.current) }
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

  // 预览点击:任务复选框切换回写源文;图片弹出放大预览;.xmind 附件链接弹出思维导图查看器;
  // 笔记深链(/?article=)应用内打开
  const handlePreviewClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      e.preventDefault()
      if (trashed) return
      const boxes = Array.from(previewRef.current?.querySelectorAll('input[type="checkbox"]') || [])
      const idx = boxes.indexOf(target)
      if (idx >= 0) {
        const next = toggleTaskItem(content, idx)
        if (next !== null) setContent(next) // 触发未保存 → 3s 自动保存
      }
      return
    }
    if (target.tagName === 'IMG' && !target.closest('a.cfnote-xmind-card')) {
      e.preventDefault()
      setLightbox((target as HTMLImageElement).src)
      return
    }
    const a = target.closest('a')
    if (!a) return
    const href = a.getAttribute('href') || ''
    const noteLink = /^\/?\?article=(\d+)/.exec(href)
    if (noteLink) {
      e.preventDefault()
      const id = Number(noteLink[1])
      if (onOpenArticle) onOpenArticle(id)
      else window.open(`/?article=${id}`, '_blank', 'noopener')
      return
    }
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
    // 富文本模式的卡片 NodeView 监听该事件,带版本号重取缩略图(绕过 immutable 强缓存)
    window.dispatchEvent(new CustomEvent('cfnote:xmind-thumb', { detail: { url: href } }))
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

  // 目录(预览与富文本模式共用;可折叠,状态存 localStorage)
  const [tocOpen, setTocOpen] = useState(() => localStorage.getItem('cfnote-toc-open') !== '0')
  const toggleToc = () =>
    setTocOpen((v) => {
      localStorage.setItem('cfnote-toc-open', v ? '0' : '1')
      return !v
    })
  const tocNav =
    headings.length >= 2 ? (
      tocOpen ? (
        <nav className="w-48 shrink-0 hidden lg:block overflow-y-auto border-l border-gray-100 pl-3 py-1">
          <div className="flex items-center justify-between mb-2 pr-1">
            <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">目录</p>
            <button
              onClick={toggleToc}
              title="折叠目录"
              className="p-0.5 rounded text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 5l7 7-7 7M5 5l7 7-7 7" />
              </svg>
            </button>
          </div>
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
      ) : (
        <div className="shrink-0 hidden lg:flex flex-col items-center border-l border-gray-100 py-1">
          <button
            onClick={toggleToc}
            title="展开目录"
            className="p-1 rounded text-gray-300 hover:text-gray-500 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
            </svg>
          </button>
        </div>
      )
    ) : null

  return (
    <div className="h-full flex flex-col">
      {/* Top bar: mode toggle + save status。窄屏按钮多,允许换行而不是横向溢出 */}
      <div className="px-3 lg:px-4 py-2 border-b border-gray-100 flex items-center justify-between gap-x-2 gap-y-1 flex-wrap shrink-0">
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
          {/* 公开到博客(私有笔记不显示;草稿先保存后才可操作;回收站只读) */}
          {article.id > 0 && !isPrivate && !trashed && (
            <>
              <span className="w-px h-4 bg-gray-200 mx-1" />
              {isPublic ? (
                <>
                  <button
                    onClick={() => setFlagConfirm('unpublish')}
                    disabled={flagBusy}
                    className="px-3 py-1 rounded text-sm bg-emerald-100 text-emerald-700 hover:bg-emerald-200 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                    title="已公开到博客,点击取消公开"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    已公开
                  </button>
                  <a
                    href={`/blog/${article.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="p-1.5 rounded text-gray-400 hover:text-emerald-600 hover:bg-emerald-50 transition-colors"
                    title="在博客中查看"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </>
              ) : (
                <button
                  onClick={handlePublishClick}
                  disabled={flagBusy || loadingContent}
                  className="px-3 py-1 rounded text-sm text-gray-500 hover:bg-gray-100 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                  title="公开到博客(发布前自动检查敏感信息)"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.055 11H5a2 2 0 012 2v1a2 2 0 002 2 2 2 0 012 2v2.945M8 3.935V5.5A2.5 2.5 0 0010.5 8h.5a2 2 0 012 2 2 2 0 104 0 2 2 0 012-2h1.064M15 20.488V18a2 2 0 012-2h3.064M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  公开
                </button>
              )}
            </>
          )}
        </div>
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap justify-end ml-auto">
          {/* P10 版本历史:查看/恢复历史快照(草稿与回收站不可用) */}
          {article.id > 0 && !trashed && (
            <button
              onClick={() => setShowVersions(true)}
              className="text-xs text-gray-400 hover:text-emerald-600 flex items-center gap-1 transition-colors"
              title="查看并恢复历史版本"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              历史
            </button>
          )}
          {/* P10 提醒:为本篇设置/清除提醒时间(草稿与回收站不可用) */}
          {article.id > 0 && !trashed && (
            <button
              onClick={() => setShowRemind((v) => !v)}
              className={`text-xs flex items-center gap-1 transition-colors ${
                remindAt ? 'text-emerald-600 hover:text-emerald-700' : 'text-gray-400 hover:text-emerald-600'
              }`}
              title={remindAt ? `提醒:${formatRemindTime(remindAt, Date.now())}` : '设置提醒时间'}
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
              </svg>
              {remindAt ? formatRemindTime(remindAt, Date.now()) : '提醒'}
            </button>
          )}
          {/* P9.3 私密分享:凭链接可看,不入博客列表;私有/回收站不可用 */}
          {article.id > 0 && !trashed && !isPrivate && (
            <button
              onClick={() => { setShareErr(''); setShareDialog(true) }}
              className={`text-xs flex items-center gap-1 transition-colors ${
                share.token && fmtRemaining(share.expires) !== '已过期'
                  ? 'text-sky-600 hover:text-sky-700'
                  : 'text-gray-400 hover:text-gray-600'
              }`}
              title={share.token ? '已生成私密分享链接,点击查看/管理' : '生成私密分享链接(凭链接可看,不进博客列表)'}
            >
              🔗 {share.token ? (fmtRemaining(share.expires) === '已过期' ? '分享已过期' : '已分享') : '分享'}
            </button>
          )}
          {/* 私有状态:私有显示标识(点击可取消),非私有显示设为私有按钮;回收站只读 */}
          {article.id > 0 && !trashed && (isPrivate ? (
            <button
              onClick={() => setFlagConfirm('unprivate')}
              className="text-xs text-amber-600 hover:text-amber-700 flex items-center gap-1 transition-colors"
              title="私有笔记:不会出现在公开博客;点击取消私有"
            >
              <EyeOffIcon className="w-3.5 h-3.5" />
              私有
            </button>
          ) : (
            <button
              onClick={() => setFlagConfirm('private')}
              className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1 transition-colors"
              title="设为私有(不可对外公开展示)"
            >
              <EyeOffIcon className="w-3.5 h-3.5" />
              设为私有
            </button>
          ))}
          <span className="text-xs text-gray-300 max-sm:hidden">{charCount} 字</span>
          {article.is_vectorized ? (
            <span className="text-xs text-emerald-500 flex items-center gap-1 max-sm:hidden">
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              已向量化
            </span>
          ) : null}
          <span className={`text-xs ${saved ? 'text-gray-400' : 'text-amber-500'}`}>
            {loadingContent ? '加载中...' : saving ? '保存中...' : saved ? '已保存' : '未保存'}
          </span>
          {!trashed && (
            <button
              onClick={handleSave}
              disabled={saving || saved}
              className="px-3 py-1 bg-emerald-500 text-white text-sm rounded-lg hover:bg-emerald-600 disabled:opacity-40 transition-colors"
            >
              保存
            </button>
          )}
        </div>
      </div>

      {/* P9 回收站横幅:软删除的笔记只读 */}
      {trashed && (
        <div className="px-4 lg:px-6 py-2 bg-amber-50 border-b border-amber-100 text-xs text-amber-700 shrink-0">
          🗑 这篇笔记在回收站中(只读),30 天后自动彻底删除;可在左侧列表悬浮操作里恢复或彻底删除。
        </div>
      )}

      {/* P9.2 反向链接条:哪些笔记链接到本篇 */}
      {backlinks.length > 0 && (
        <div className="px-4 lg:px-6 py-1.5 bg-gray-50 border-b border-gray-100 text-xs text-gray-500 shrink-0 flex items-center gap-x-2 gap-y-0.5 flex-wrap">
          <span className="text-gray-400 shrink-0">🔗 {backlinks.length} 篇笔记链接到此篇:</span>
          {backlinks.map((b) => (
            <button
              key={b.id}
              onClick={() => (onOpenArticle ? onOpenArticle(b.id) : window.open(`/?article=${b.id}`, '_blank', 'noopener'))}
              className="text-emerald-600 hover:underline truncate max-w-[16rem]"
              title="打开这篇笔记"
            >
              《{b.title}》
            </button>
          ))}
        </div>
      )}

      {/* Markdown formatting toolbar (edit mode only) */}
      {mode === 'edit' && !trashed && (
        <div className="px-4 py-1.5 border-b border-gray-100 flex items-center gap-0.5 shrink-0 overflow-x-auto">
          {TOOLBAR_GROUPS.map((group, gi) => (
            <div key={gi} className="flex items-center gap-0.5 shrink-0">
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
          <button
            title="插入附件:上传新文件或从文件库选择"
            onClick={() => setShowFilePicker(true)}
            className="px-2 py-1 rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
          <button
            title="插入笔记链接(引用另一篇笔记)"
            onClick={() => setShowNoteLink(true)}
            className="px-2 py-1 rounded text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </button>
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
      <div className="px-4 lg:px-6 pt-3 lg:pt-4 shrink-0">
        <input
          type="text"
          value={title}
          readOnly={trashed}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full text-xl lg:text-2xl font-bold text-gray-900 border-none outline-none bg-transparent placeholder:text-gray-300"
          placeholder="文章标题"
        />
        {/* P9 标签行:前置标签图标 + chips + 虚线胶囊输入(datalist 补全已有标签);回收站只读展示 */}
        <div className="flex items-center gap-1.5 flex-wrap mt-2">
          <span className="text-gray-400 shrink-0" title="标签">
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 6h.008v.008H6V6z" />
            </svg>
          </span>
          {tags.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
              # {t}
              {!trashed && (
                <button
                  onClick={() => setTags(tags.filter((x) => x !== t))}
                  className="text-emerald-400 hover:text-emerald-700"
                  title="移除标签"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {!trashed && tags.length < 20 && (
            <label
              className={`inline-flex items-center gap-0.5 rounded-full border border-dashed px-2 py-0.5 cursor-text transition-colors ${
                tags.length === 0 ? 'border-emerald-400/70 hover:bg-emerald-50' : 'border-gray-300 hover:border-emerald-400/70'
              }`}
              title="输入后回车或逗号添加标签"
            >
              <span className={`text-xs leading-none ${tags.length === 0 ? 'text-emerald-500' : 'text-gray-400'}`}>+</span>
              <input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    const v = tagInput.trim().replace(/,+$/, '').slice(0, 30)
                    if (v && !tags.includes(v)) setTags([...tags, v])
                    setTagInput('')
                  }
                  if (e.key === 'Backspace' && !tagInput && tags.length > 0) setTags(tags.slice(0, -1))
                }}
                onBlur={() => {
                  const v = tagInput.trim().slice(0, 30)
                  if (v && !tags.includes(v)) setTags([...tags, v])
                  setTagInput('')
                }}
                list="cfnote-tag-suggestions"
                placeholder={tags.length === 0 ? '添加标签' : '添加'}
                className={`text-xs text-gray-700 bg-transparent border-none outline-none ${
                  tags.length === 0 ? 'w-16 placeholder:text-emerald-600/70' : 'w-10 placeholder:text-gray-400'
                }`}
              />
              <datalist id="cfnote-tag-suggestions">
                {(allTags || []).filter((t) => !tags.includes(t)).map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
            </label>
          )}
        </div>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden px-4 lg:px-6 py-3 lg:py-4">
        {mode === 'edit' ? (
          <textarea
            ref={textareaRef}
            value={content}
            readOnly={loadingContent || trashed}
            onChange={(e) => setContent(e.target.value)}
            onPaste={handlePaste}
            onClick={handleTextareaClick}
            className="w-full h-full resize-none border-none outline-none text-gray-700 leading-relaxed text-[15px] font-mono bg-transparent placeholder:text-gray-300"
            placeholder="开始写作... (支持 Markdown 语法)"
          />
        ) : mode === 'wysiwyg' ? (
          <div ref={wysiwygWrapRef} className="h-full flex gap-4">
            <div className="flex-1 min-w-0 h-full flex flex-col">
              {IS_MOBILE && (
                <div className="text-[11px] text-gray-400 pb-1 shrink-0">📱 移动端富文本为只读,编辑请切换到「源码」模式</div>
              )}
              <div className="flex-1 min-h-0">
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
                    readOnly={loadingContent || IS_MOBILE || trashed}
                    token={token}
                    onUploadFile={uploadFileRaw}
                    onPatchContent={(fn) => setContent((prev) => fn(prev))}
                    onImagePreview={setLightbox}
                    onOpenXmind={(url, name) => {
                      xmindSavedRef.current = false
                      setXmindFile({ url, name })
                    }}
                  />
                </Suspense>
              </div>
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

      {/* P9.3 私密分享弹窗(与文件分享同构:单分享,重新生成即替换,取消立即失效) */}
      {shareDialog && (() => {
        const active = !!share.token && fmtRemaining(share.expires) !== '已过期'
        return (
          <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center" onMouseDown={() => setShareDialog(false)}>
            <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[92vw] p-4" onMouseDown={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-gray-900 mb-1">私密分享「{title || article.title}」</h3>
              <p className="text-[11px] text-gray-400 mb-3">
                任何拿到链接的人在有效期内可阅读这篇笔记(含其附件),但它不会出现在博客列表与热榜。
                一篇笔记同时只有一个分享链接,重新生成后旧链接立即失效;设为私有或删除笔记会自动撤销分享。
              </p>
              {share.token && (
                <div className="mb-3 border border-sky-100 bg-sky-50/60 rounded-lg p-2.5">
                  <div className="flex items-center gap-2">
                    <input
                      readOnly
                      value={`${location.origin}/blog/share/${share.token}`}
                      onFocus={(e) => e.target.select()}
                      className="flex-1 min-w-0 text-[11px] text-gray-600 bg-white border border-gray-200 rounded px-2 py-1 focus:outline-none"
                    />
                    <button
                      onClick={async () => { if (await copyShareLink(share.token!)) setShareErr('') }}
                      className="px-2 py-1 text-[11px] rounded bg-sky-500 text-white hover:bg-sky-600 shrink-0"
                    >
                      复制
                    </button>
                  </div>
                  <p className="text-[11px] mt-1.5 flex items-center justify-between">
                    <span className={active ? 'text-sky-600' : 'text-amber-600'}>
                      {active ? `有效期:${fmtRemaining(share.expires)}` : '已过期,可选择有效期重新生成'}
                    </span>
                    <button onClick={cancelShare} className="text-red-400 hover:text-red-600 hover:underline">取消分享</button>
                  </p>
                </div>
              )}
              <p className="text-xs font-medium text-gray-600 mb-1.5">有效期</p>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {EXPIRY_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    onClick={() => setSharePreset(p.seconds)}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                      sharePreset === p.seconds
                        ? 'border-emerald-400 bg-emerald-50 text-emerald-700 font-medium'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              {shareErr && <p className="text-[11px] text-red-500 mb-2">{shareErr}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={() => setShareDialog(false)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">关闭</button>
                <button
                  onClick={submitShare}
                  disabled={shareBusy}
                  className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50"
                >
                  {shareBusy ? '生成中…' : share.token ? '重新生成链接' : '生成链接并复制'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 笔记链接选择器(源码模式;富文本模式由 WysiwygEditor 自行承载) */}
      {showNoteLink && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <NoteLinkDialog
            token={token}
            excludeId={article.id}
            onClose={() => setShowNoteLink(false)}
            onPick={(a: NoteLinkItem) => insertAtCursor(`[${a.title.replace(/([[\]])/g, '\\$1')}](/?article=${a.id})`)}
          />
        </Suspense>
      )}

      {/* 文件库选择器(源码模式;富文本模式由 WysiwygEditor 自行承载) */}
      {showFilePicker && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <FilePickerDialog
            token={token}
            onClose={() => setShowFilePicker(false)}
            onPick={insertPicked}
            onUpload={uploadPicked}
          />
        </Suspense>
      )}

      {/* P10 版本历史对话框 */}
      {showVersions && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <VersionHistoryDialog
            articleId={article.id}
            token={token}
            onClose={() => setShowVersions(false)}
            onRestore={restoreVersion}
          />
        </Suspense>
      )}

      {/* P10 提醒设置对话框 */}
      {showRemind && (
        <div className="fixed inset-0 z-[85] bg-black/40 flex items-center justify-center p-4" onMouseDown={() => setShowRemind(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-80 max-w-[92vw] p-5" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-1">设置提醒</h3>
            {remindAt ? (
              <p className="text-xs text-emerald-600 mb-3">当前提醒:{formatRemindTime(remindAt, Date.now())}</p>
            ) : (
              <p className="text-xs text-gray-400 mb-3">选择一个时间,到期后会在顶栏铃铛提示。</p>
            )}
            <div className="flex flex-wrap gap-2">
              {remindPresets().map((p) => (
                <button
                  key={p.label}
                  onClick={() => setReminder(p.iso)}
                  disabled={remindBusy}
                  className="px-3 py-1.5 rounded-lg text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-500/10 disabled:opacity-40 transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <label className="block mt-4 text-xs text-gray-500 dark:text-gray-400">
              自定义时间
              <input
                type="datetime-local"
                disabled={remindBusy}
                onChange={(e) => { if (e.target.value) setReminder(new Date(e.target.value).toISOString()) }}
                className="mt-1 w-full px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-transparent text-sm text-gray-700 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
              />
            </label>
            <div className="mt-4 flex items-center justify-between">
              {remindAt ? (
                <button onClick={() => setReminder(null)} disabled={remindBusy} className="text-xs text-red-500 hover:text-red-600 disabled:opacity-40">
                  清除提醒
                </button>
              ) : <span />}
              <button onClick={() => setShowRemind(false)} className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-700">
                关闭
              </button>
            </div>
          </div>
        </div>
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

      {/* 公开前检查弹窗:文本风险项 + 将随文公开的附件清单(含私有交叉引用警告 + 私密文件夹附件单列) */}
      {publishDialog && (() => {
        const files = publishDialog.files
        const pubFiles = (files || []).filter((f) => !f.private_file)
        const privFiles = (files || []).filter((f) => f.private_file)
        const crossPrivate = pubFiles.some((f) => f.other_refs.some((o) => o.is_private))
        const hasRisk = publishDialog.risks.length > 0 || crossPrivate
        return (
          <div className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40" onMouseDown={() => setPublishDialog(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-[560px] max-w-[94vw] p-5" onMouseDown={(e) => e.stopPropagation()}>
              {publishDialog.risks.length > 0 ? (
                <>
                  <h3 className="text-sm font-semibold text-red-600 mb-1 flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                    </svg>
                    检测到 {publishDialog.risks.length} 处疑似敏感信息
                  </h3>
                  <p className="text-xs text-gray-500 mb-3">
                    公开后任何人都能访问这篇笔记。请逐条确认以下内容(摘录已打码,原文未改动):
                  </p>
                  <div className="max-h-[38vh] overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-50">
                    {publishDialog.risks.map((r, i) => (
                      <div key={i} className="px-3 py-2 flex items-start gap-2">
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 shrink-0 mt-0.5 whitespace-nowrap">{r.label}</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-700 font-mono break-all">{r.excerpt}</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">{r.line === 1 ? '标题' : `正文第 ${r.line - 1} 行`}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <h3 className="text-sm font-semibold text-gray-900 mb-1">✅ 未检测到敏感信息</h3>
                  <p className="text-xs text-gray-500">
                    已检查:手机号 / 身份证 / 银行卡 / 邮箱 / 各类密钥令牌 / 密码。公开后这篇笔记会出现在博客页,任何人可访问。
                  </p>
                </>
              )}

              {/* 附件清单:文本扫描覆盖不了截图等文件内容,列出让用户目视确认 */}
              {files === null ? (
                <p className="text-xs text-gray-400 mt-3">附件检查中…</p>
              ) : pubFiles.length > 0 ? (
                <div className="mt-3">
                  <p className="text-xs font-medium text-gray-600 mb-1.5">将随笔记公开的附件({pubFiles.length})</p>
                  <div className="max-h-[24vh] overflow-y-auto border border-gray-100 rounded-xl divide-y divide-gray-50">
                    {pubFiles.map((f) => (
                      <div key={f.key} className="px-3 py-2 flex items-center gap-2.5">
                        {f.thumb ? (
                          <img
                            src={f.thumb}
                            alt=""
                            className="w-9 h-9 rounded-md object-cover border border-gray-100 shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <span className="w-9 h-9 rounded-md bg-gray-50 flex items-center justify-center text-base shrink-0">📄</span>
                        )}
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-700 truncate">{f.name}</p>
                          {f.other_refs.length > 0 && (
                            <p className="text-[11px] text-gray-400 mt-0.5 truncate">
                              同时被引用:{f.other_refs.map((o) => `《${o.title}》${o.is_private ? '(私有)' : o.is_public ? '(公开)' : ''}`).join('、')}
                            </p>
                          )}
                        </div>
                        {f.other_refs.some((o) => o.is_private) && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 shrink-0">私有笔记引用中</span>
                        )}
                      </div>
                    ))}
                  </div>
                  {crossPrivate && (
                    <p className="text-[11px] text-amber-600 mt-1.5">
                      ⚠ 标注的附件同时被私有笔记引用:公开后附件本身对外可见,请确认其内容可公开。
                    </p>
                  )}
                </div>
              ) : null}

              {/* 私密文件夹附件:不随笔记公开,访客访问链接会失效(要公开须先在文件管理中移出) */}
              {privFiles.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-amber-700 mb-1.5">🔒 私密文件夹附件({privFiles.length})——不随笔记公开</p>
                  <div className="max-h-[18vh] overflow-y-auto border border-amber-100 rounded-xl divide-y divide-amber-50 bg-amber-50/40">
                    {privFiles.map((f) => (
                      <div key={f.key} className="px-3 py-2 flex items-center gap-2.5">
                        {f.thumb ? (
                          <img
                            src={f.thumb}
                            alt=""
                            className="w-9 h-9 rounded-md object-cover border border-amber-100 shrink-0"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                          />
                        ) : (
                          <span className="w-9 h-9 rounded-md bg-white flex items-center justify-center text-base shrink-0">🔒</span>
                        )}
                        <p className="text-xs text-gray-700 truncate flex-1">{f.name}</p>
                        <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">私密文件</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-gray-400 mt-1.5">
                    这些附件在「我的私密文件夹」中,笔记公开后访客将看不到它们(链接失效)。要一并公开,请先在文件管理中把文件移出私密文件夹。
                  </p>
                </div>
              )}

              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setPublishDialog(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
                  取消
                </button>
                <button
                  onClick={() => applyFlags({ is_public: 1 })}
                  disabled={flagBusy || files === null}
                  className={`px-3 py-1.5 text-xs rounded-lg text-white transition-colors disabled:opacity-50 ${
                    hasRisk ? 'bg-red-500 hover:bg-red-600' : 'bg-emerald-500 hover:bg-emerald-600'
                  }`}
                >
                  {flagBusy
                    ? '发布中...'
                    : files === null
                      ? '附件检查中...'
                      : publishDialog.risks.length > 0
                        ? '我已逐条确认,仍要公开'
                        : crossPrivate
                          ? '我已确认附件,仍要公开'
                          : '确认公开'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {flagConfirm === 'private' && (
        <ConfirmDialog
          title="设为私有？"
          message="私有笔记不会出现在公开博客(若已公开将同时取消公开),列表标题前会显示私有标识。"
          confirmText="设为私有"
          variant="amber"
          onConfirm={() => { setFlagConfirm(null); applyFlags({ is_private: 1 }) }}
          onCancel={() => setFlagConfirm(null)}
        />
      )}
      {flagConfirm === 'unprivate' && (
        <ConfirmDialog
          title="取消私有？"
          message="取消后这篇笔记恢复为普通笔记,可再次公开到博客。"
          confirmText="取消私有"
          variant="emerald"
          onConfirm={() => { setFlagConfirm(null); applyFlags({ is_private: 0 }) }}
          onCancel={() => setFlagConfirm(null)}
        />
      )}
      {flagConfirm === 'unpublish' && (
        <ConfirmDialog
          title="取消公开？"
          message="取消后博客中将不再展示这篇笔记。"
          confirmText="取消公开"
          onConfirm={() => { setFlagConfirm(null); applyFlags({ is_public: 0 }) }}
          onCancel={() => setFlagConfirm(null)}
        />
      )}
    </div>
  )
}
