import { useEffect, useRef, useState, useCallback } from 'react'
import { useEditor, EditorContent, useEditorState } from '@tiptap/react'
import { buildExtensions } from '../lib/wysiwygExtensions'

interface Props {
  value: string
  onChange: (md: string) => void
  readOnly?: boolean
}

// P6.1 所见即所得编辑器:TipTap + tiptap-markdown,单一事实源是父组件的 Markdown 字符串。
// 只有用户真实编辑才回写(防抖 250ms,失焦/卸载即时 flush)——打开不动就保存,内容零 diff。
export default function WysiwygEditor({ value, onChange, readOnly }: Props) {
  const lastMdRef = useRef(value)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const [linkDialog, setLinkDialog] = useState<{ url: string } | null>(null)

  const editor = useEditor({
    extensions: buildExtensions(),
    content: value,
    editable: !readOnly,
    editorProps: {
      attributes: {
        class: 'cfnote-preview prose prose-sm max-w-none focus:outline-none cfnote-wysiwyg-content',
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

  // 外部值变化(切换文章/正文加载完成):整体替换,不触发 onUpdate
  useEffect(() => {
    if (!editor || value === lastMdRef.current) return
    lastMdRef.current = value
    editor.commands.setContent(value, { emitUpdate: false } as any)
  }, [value, editor])

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

      <EditorContent editor={editor} className="flex-1 overflow-y-auto min-h-0 cfnote-wysiwyg" />

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
    </div>
  )
}
