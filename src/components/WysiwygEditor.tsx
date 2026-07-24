import { useEffect, useMemo, useRef, useState, useCallback, lazy, Suspense } from 'react'
import { useEditor, EditorContent, useEditorState, type Editor } from '@tiptap/react'
import { buildExtensions } from '../lib/wysiwygExtensions'
import { wysiwygPasteAction, applyMarkdownPaste, applyCodePaste, type RichPasteAction } from '../lib/pasteDetect'

// P8.3 文件库选择器(与源码模式共用组件,懒加载)
const FilePickerDialog = lazy(() => import('./FilePickerDialog'))
import type { PickedFile } from './FilePickerDialog'

interface UploadedFile {
  url: string
  name: string
  content_type: string
}

interface Props {
  value: string
  onChange: (md: string) => void
  readOnly?: boolean
  /** 文件库选择器需要的登录态(P8.3):缺省时附件按钮退化为直接上传 */
  token?: string
  /** 上传到 R2,失败抛错(与源码模式共用同一实现,10MB 限制与错误提示一致) */
  onUploadFile?: (file: File) => Promise<UploadedFile>
  /** 编辑器已卸载时的兜底:对父层内容字符串做函数式修补(blob 占位 → 正式 URL) */
  onPatchContent?: (fn: (prev: string) => string) => void
  /** 双击图片放大(复用父层 lightbox) */
  onImagePreview?: (src: string) => void
  /** 双击 xmind 卡片:打开 XmindViewer 弹窗(由父层承载) */
  onOpenXmind?: (url: string, name: string) => void
}

// 按 src 定位图片节点:上传完成后把 blob 预览地址替换为 R2 正式地址(位置无关,用户中途编辑也能找到)
function findImageBySrc(ed: Editor, src: string): { pos: number; node: any } | null {
  const hits: Array<{ pos: number; node: any }> = []
  ed.view.state.doc.descendants((n, pos) => {
    if (hits.length) return false
    if (n.type.name === 'image' && n.attrs.src === src) {
      hits.push({ pos, node: n })
      return false
    }
    return true
  })
  return hits[0] ?? null
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// P6.1 所见即所得编辑器:TipTap + tiptap-markdown,单一事实源是父组件的 Markdown 字符串。
// 只有用户真实编辑才回写(防抖 250ms,失焦/卸载即时 flush)——打开不动就保存,内容零 diff。
export default function WysiwygEditor({ value, onChange, readOnly, token, onUploadFile, onPatchContent, onImagePreview, onOpenXmind }: Props) {
  const lastMdRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [linkDialog, setLinkDialog] = useState<{ url: string } | null>(null)
  // P6.3 xmind 卡片改名弹窗(pos 为卡片节点位置,确认时校验节点类型后 setNodeMarkup)
  const [renameDialog, setRenameDialog] = useState<{ pos: number; label: string } | null>(null)
  // P6.2 上传:pending 计数驱动"上传中"指示,错误提示 5s 自动消失
  const [pending, setPending] = useState(0)
  const [uploadErr, setUploadErr] = useState('')
  // P8.3 文件库选择器
  const [showPicker, setShowPicker] = useState(false)
  const uploadRef = useRef(onUploadFile)
  uploadRef.current = onUploadFile
  const patchRef = useRef(onPatchContent)
  patchRef.current = onPatchContent
  const openXmindRef = useRef(onOpenXmind)
  openXmindRef.current = onOpenXmind
  // editorProps 的 handler 在编辑器创建时固化,经 ref 调到每次渲染刷新的最新实现
  const filesRef = useRef<(files: File[], pos?: number) => void>(() => {})
  const richPasteRef = useRef<(act: RichPasteAction, text: string) => void>(() => {})

  // 扩展集只建一次;卡片回调经 ref/稳定 setter 转发,始终指向最新实现
  const extensions = useMemo(
    () =>
      buildExtensions({
        onOpenXmind: (url, name) => openXmindRef.current?.(url, name),
        onRenameXmind: (pos, label) => setRenameDialog({ pos, label }),
      }),
    [],
  )

  const editor = useEditor({
    extensions,
    content: value,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: 'cfnote-preview prose prose-sm max-w-none focus:outline-none cfnote-wysiwyg-content',
      },
      // 粘贴截图/图片文件:直传 R2(与源码模式一致);
      // Markdown/代码源文的高亮 HTML(VS Code、AI 代码块等):改用纯文本按相应结构解析,
      // 避免整篇被 ProseMirror 当成 ```markdown 代码块或样式碎片;其余富文本走默认解析
      handlePaste: (view, event) => {
        if (!view.editable) return false
        const imgs = Array.from(event.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'))
        if (imgs.length) {
          event.preventDefault()
          filesRef.current(imgs)
          return true
        }
        const text = event.clipboardData?.getData('text/plain') || ''
        const act = wysiwygPasteAction({
          html: event.clipboardData?.getData('text/html') || '',
          text,
          vscodeMeta: event.clipboardData?.getData('vscode-editor-data') || '',
        })
        if (!act) return false
        event.preventDefault()
        richPasteRef.current(act, text)
        return true
      },
      // 拖入文件:在落点位置插入(图片→图片节点,其他→📎 链接);编辑器内部节点拖动(moved)不拦截
      handleDrop: (view, event, _slice, moved) => {
        if (moved || !view.editable) return false
        const files = Array.from(event.dataTransfer?.files || [])
        if (!files.length) return false
        event.preventDefault()
        const coords = view.posAtCoords({ left: event.clientX, top: event.clientY })
        filesRef.current(files, coords?.pos)
        return true
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        const md = (ed.storage as any).markdown.getMarkdown()
        lastMdRef.current = md
        onChangeRef.current(md)
      }, 250)
    },
    onBlur: ({ editor: ed }) => {
      if (!timerRef.current) return
      clearTimeout(timerRef.current)
      timerRef.current = null
      const md = (ed.storage as any).markdown.getMarkdown()
      lastMdRef.current = md
      onChangeRef.current(md)
    },
  })

  // 卸载(切换模式)时 flush 未落盘的编辑
  useEffect(() => {
    return () => {
      if (!timerRef.current || !editor || editor.isDestroyed) return
      clearTimeout(timerRef.current)
      timerRef.current = null
      const md = (editor.storage as any).markdown.getMarkdown()
      lastMdRef.current = md
      onChangeRef.current(md)
    }
  }, [editor])

  // 外部值变化(切换文章/正文加载完成):整体替换,不触发 onUpdate。
  // IME 组合输入(中文拼音等)进行中不替换——那会打断组合导致丢字,组合结束后经 syncTick 重试。
  const [syncTick, setSyncTick] = useState(0)
  useEffect(() => {
    if (!editor || value === lastMdRef.current) return
    if (editor.view.composing) {
      const dom = editor.view.dom
      const once = () => setSyncTick((t) => t + 1)
      dom.addEventListener('compositionend', once, { once: true })
      return () => dom.removeEventListener('compositionend', once)
    }
    lastMdRef.current = value
    editor.commands.setContent(value, { emitUpdate: false } as any)
  }, [value, editor, syncTick])

  useEffect(() => {
    editor?.setEditable(!readOnly)
  }, [editor, readOnly])

  const st = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            h1: e.isActive('heading', { level: 1 }),
            h2: e.isActive('heading', { level: 2 }),
            h3: e.isActive('heading', { level: 3 }),
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            codeBlock: e.isActive('codeBlock'),
            blockquote: e.isActive('blockquote'),
            bulletList: e.isActive('bulletList'),
            orderedList: e.isActive('orderedList'),
            link: e.isActive('link'),
            table: e.isActive('table'),
            canUndo: e.can().undo(),
            canRedo: e.can().redo(),
          }
        : null,
  })

  const openLinkDialog = useCallback(() => {
    if (!editor) return
    setLinkDialog({ url: editor.getAttributes('link').href || '' })
  }, [editor])

  const applyLink = () => {
    if (!editor || !linkDialog) return
    const href = linkDialog.url.trim()
    const chain = editor.chain().focus().extendMarkRange('link')
    if (href) chain.setLink({ href }).run()
    else chain.unsetLink().run()
    setLinkDialog(null)
  }

  const applyRename = () => {
    if (!editor || !renameDialog) return
    const label = renameDialog.label.trim()
    const { pos } = renameDialog
    const node = editor.state.doc.nodeAt(pos)
    // 弹窗期间文档未变(模态),仍按类型校验兜底;只改链接文本,不动 R2 文件
    if (label && node?.type.name === 'xmindCard') {
      editor.view.dispatch(editor.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, label }))
    }
    setRenameDialog(null)
  }

  // ---- P6.2 图片/附件上传 ----
  // 图片:先用 blob 地址插入节点即时预览(NodeView 半透明提示上传中),上传成功替换为 R2 地址,
  // 失败则移除节点并提示。若上传期间编辑器被卸载(切模式/切文章),flush 出去的内容可能带 blob
  // 占位,此时在父层内容字符串上修补,避免落库坏链接。非图片文件上传完成后插入 📎 链接。
  const uploadOne = useCallback(async (ed: Editor, file: File) => {
    const upload = uploadRef.current
    if (!upload) return
    const isImg = file.type.startsWith('image/')
    setUploadErr('')
    setPending((n) => n + 1)
    let blobUrl = ''
    if (isImg) {
      blobUrl = URL.createObjectURL(file)
      ed.chain().focus().insertContent({ type: 'image', attrs: { src: blobUrl, alt: file.name || '图片' } }).run()
    }
    try {
      const info = await upload(file)
      if (!isImg) {
        if (!ed.isDestroyed) {
          ed.chain().focus().insertContent([
            { type: 'text', marks: [{ type: 'link', attrs: { href: info.url } }], text: `📎 ${info.name}` },
            { type: 'text', text: ' ' },
          ]).run()
        } else {
          patchRef.current?.((prev) => prev + (prev && !prev.endsWith('\n') ? '\n' : '') + `[📎 ${info.name}](${info.url})`)
        }
      } else if (!ed.isDestroyed) {
        const hit = findImageBySrc(ed, blobUrl)
        if (hit) {
          ed.view.dispatch(ed.view.state.tr.setNodeMarkup(hit.pos, undefined, { ...hit.node.attrs, src: info.url, alt: info.name }))
        }
      } else {
        patchRef.current?.((prev) => prev.split(blobUrl).join(info.url))
      }
    } catch (e: any) {
      if (isImg) {
        if (!ed.isDestroyed) {
          const hit = findImageBySrc(ed, blobUrl)
          if (hit) ed.view.dispatch(ed.view.state.tr.delete(hit.pos, hit.pos + hit.node.nodeSize))
        } else {
          patchRef.current?.((prev) => prev.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escRe(blobUrl)}\\)\\n?`), ''))
        }
      }
      setUploadErr(e?.message || '上传失败')
      setTimeout(() => setUploadErr(''), 5000)
    } finally {
      if (blobUrl) URL.revokeObjectURL(blobUrl)
      setPending((n) => n - 1)
    }
  }, [])

  // 粘贴/拖入/工具栏统一入口;拖入带落点位置时先移动光标(多文件按调用序依次插在光标后,顺序自然保持)
  filesRef.current = (files, pos) => {
    if (!editor || !uploadRef.current) return
    if (typeof pos === 'number') {
      editor.chain().focus().setTextSelection(Math.min(pos, editor.state.doc.content.size)).run()
    }
    for (const f of files) void uploadOne(editor, f)
  }

  // 粘贴拦截的应用侧:markdown 走 tiptap-markdown 解析插入,code 进代码块节点
  richPasteRef.current = (act, text) => {
    if (!editor) return
    if (act.action === 'markdown') applyMarkdownPaste(editor, text)
    else applyCodePaste(editor, text, act.language)
  }

  // P8.3 从文件库选中:插入既有 URL(图片→图片节点,其他→📎 链接,与上传完成后的插入形态一致;
  // .xmind 链接在下次内容解析时呈现为卡片,与上传路径行为相同)
  const insertPicked = useCallback((f: PickedFile) => {
    if (!editor) return
    if (f.category === 'image') {
      editor.chain().focus().insertContent({ type: 'image', attrs: { src: f.url, alt: f.name } }).run()
    } else {
      editor.chain().focus().insertContent([
        { type: 'text', marks: [{ type: 'link', attrs: { href: f.url } }], text: `📎 ${f.name}` },
        { type: 'text', text: ' ' },
      ]).run()
    }
  }, [editor])

  if (!editor) return null
  const c = () => editor.chain().focus()

  const TBtn = ({
    onClick, active, disabled, title, children,
  }: {
    onClick: () => void
    active?: boolean
    disabled?: boolean
    title: string
    children: React.ReactNode
  }) => (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-1.5 py-0.5 rounded text-xs min-w-[26px] transition-colors disabled:opacity-30 ${
        active ? 'bg-emerald-100 text-emerald-700' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700'
      }`}
    >
      {children}
    </button>
  )

  const Sep = () => <span className="w-px h-4 bg-gray-200 mx-0.5" />

  return (
    <div className="h-full flex flex-col min-w-0">
      {/* 工具栏 */}
      {!readOnly && (
        <div className="flex items-center flex-wrap gap-0.5 pb-2 mb-2 border-b border-gray-100 shrink-0">
          <TBtn title="撤销 (Ctrl+Z)" disabled={!st?.canUndo} onClick={() => c().undo().run()}>↩</TBtn>
          <TBtn title="重做 (Ctrl+Y)" disabled={!st?.canRedo} onClick={() => c().redo().run()}>↪</TBtn>
          <Sep />
          <TBtn title="一级标题" active={st?.h1} onClick={() => c().toggleHeading({ level: 1 }).run()}>H1</TBtn>
          <TBtn title="二级标题" active={st?.h2} onClick={() => c().toggleHeading({ level: 2 }).run()}>H2</TBtn>
          <TBtn title="三级标题" active={st?.h3} onClick={() => c().toggleHeading({ level: 3 }).run()}>H3</TBtn>
          <Sep />
          <TBtn title="加粗 (Ctrl+B)" active={st?.bold} onClick={() => c().toggleBold().run()}><b>B</b></TBtn>
          <TBtn title="斜体 (Ctrl+I)" active={st?.italic} onClick={() => c().toggleItalic().run()}><i>I</i></TBtn>
          <TBtn title="删除线" active={st?.strike} onClick={() => c().toggleStrike().run()}><s>S</s></TBtn>
          <TBtn title="行内代码" active={st?.code} onClick={() => c().toggleCode().run()}>{'<>'}</TBtn>
          <TBtn title="链接" active={st?.link} onClick={openLinkDialog}>🔗</TBtn>
          <Sep />
          <TBtn title="引用" active={st?.blockquote} onClick={() => c().toggleBlockquote().run()}>❝</TBtn>
          <TBtn title="代码块" active={st?.codeBlock} onClick={() => c().toggleCodeBlock().run()}>{'{ }'}</TBtn>
          <TBtn title="无序列表" active={st?.bulletList} onClick={() => c().toggleBulletList().run()}>•≡</TBtn>
          <TBtn title="有序列表" active={st?.orderedList} onClick={() => c().toggleOrderedList().run()}>1≡</TBtn>
          <TBtn title="分割线" onClick={() => c().setHorizontalRule().run()}>—</TBtn>
          <TBtn title="插入表格" onClick={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>⊞</TBtn>
          {onUploadFile && (
            <>
              <Sep />
              <label
                title="插入图片(也可直接粘贴/拖入)"
                className={`px-1.5 py-0.5 rounded text-xs min-w-[26px] inline-flex items-center justify-center transition-colors cursor-pointer text-gray-500 hover:bg-gray-100 hover:text-gray-700 ${pending ? 'opacity-50 pointer-events-none' : ''}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <input
                  type="file" accept="image/*" multiple className="hidden" disabled={pending > 0}
                  onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) filesRef.current(fs) }}
                />
              </label>
              {token ? (
                <TBtn title="插入附件:上传新文件或从文件库选择" onClick={() => setShowPicker(true)}>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                </TBtn>
              ) : (
                <label
                  title="插入附件(任意文件,≤10MB)"
                  className={`px-1.5 py-0.5 rounded text-xs min-w-[26px] inline-flex items-center justify-center transition-colors cursor-pointer text-gray-500 hover:bg-gray-100 hover:text-gray-700 ${pending ? 'opacity-50 pointer-events-none' : ''}`}
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                  <input
                    type="file" className="hidden" disabled={pending > 0}
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) filesRef.current([f]) }}
                  />
                </label>
              )}
            </>
          )}
          {pending > 0 && (
            <span className="flex items-center gap-1 text-xs text-gray-400 ml-1">
              <span className="w-3 h-3 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              上传中...
            </span>
          )}
          {uploadErr && <span className="text-xs text-red-500 ml-1 truncate max-w-[200px]" title={uploadErr}>{uploadErr}</span>}
          {st?.table && (
            <>
              <Sep />
              <TBtn title="下方插入行" onClick={() => c().addRowAfter().run()}>+行</TBtn>
              <TBtn title="右侧插入列" onClick={() => c().addColumnAfter().run()}>+列</TBtn>
              <TBtn title="删除当前行" onClick={() => c().deleteRow().run()}>-行</TBtn>
              <TBtn title="删除当前列" onClick={() => c().deleteColumn().run()}>-列</TBtn>
              <TBtn title="删除表格" onClick={() => c().deleteTable().run()}>删表</TBtn>
            </>
          )}
        </div>
      )}

      <EditorContent
        editor={editor}
        className="flex-1 overflow-y-auto min-h-0 cfnote-wysiwyg"
        onDoubleClick={(e) => {
          // 双击图片放大(单击留给节点选中/调宽);xmind 卡片的缩略图归卡片自身的双击打开查看器
          const t = e.target as HTMLElement
          if (t.closest('a.cfnote-xmind-card')) return
          if (t instanceof HTMLImageElement && onImagePreview) {
            e.preventDefault()
            onImagePreview(t.src)
          }
        }}
      />

      {/* P8.3 文件库选择器:选中插入既有 URL;上传 Tab 走统一上传管线(blob 占位/错误回滚等一致) */}
      {showPicker && token && (
        <Suspense fallback={
          <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          </div>
        }>
          <FilePickerDialog
            token={token}
            onClose={() => setShowPicker(false)}
            onPick={insertPicked}
            onUpload={(fs) => filesRef.current(fs)}
          />
        </Suspense>
      )}

      {/* 链接编辑弹窗 */}
      {linkDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={() => setLinkDialog(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[92vw] p-5" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">🔗 链接</h3>
            <input
              autoFocus
              type="url"
              value={linkDialog.url}
              onChange={(e) => setLinkDialog({ url: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyLink()
                if (e.key === 'Escape') setLinkDialog(null)
              }}
              placeholder="https://example.com(留空则移除链接)"
              className="w-full px-3 py-2 text-sm text-gray-800 bg-gray-50 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setLinkDialog(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
                取消
              </button>
              <button onClick={applyLink} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors">
                确定
              </button>
            </div>
          </div>
        </div>
      )}
      {/* xmind 卡片改名弹窗:只改 MD 里的链接文字 */}
      {renameDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onMouseDown={() => setRenameDialog(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-[420px] max-w-[92vw] p-5" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-3">✏️ 卡片显示名</h3>
            <input
              autoFocus
              type="text"
              value={renameDialog.label}
              onChange={(e) => setRenameDialog({ ...renameDialog, label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyRename()
                if (e.key === 'Escape') setRenameDialog(null)
              }}
              placeholder="显示名(即链接文字,不改动文件本身)"
              className="w-full px-3 py-2 text-sm text-gray-800 bg-gray-50 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => setRenameDialog(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors">
                取消
              </button>
              <button onClick={applyRename} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors">
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
