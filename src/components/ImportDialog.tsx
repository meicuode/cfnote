import { useState, useEffect, useRef } from 'react'
import { DOC_EXT } from '../lib/importTitle'

interface Props {
  loading: boolean
  progress?: string
  /** 导入完成但有跳过项时的说明。有值时对话框不自动关,让人看得见 */
  result?: string
  onImport: (url: string) => Promise<void>
  onImportFiles: (files: File[], keepTree: boolean) => Promise<void>
  onClose: () => void
}

export default function ImportDialog({ loading, progress, result, onImport, onImportFiles, onClose }: Props) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  // P16.4:默认把文件夹层级建成笔记本树。取消勾选退回 P15.4 的老行为
  // (全部进当前笔记本,相对路径写进标题),留作逃生口
  const [keepTree, setKeepTree] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleSubmit = async () => {
    const trimmed = url.trim()
    if (!trimmed) { setError('请输入文章链接'); return }
    try { new URL(trimmed) } catch { setError('请输入有效的 URL'); return }
    setError('')
    try {
      await onImport(trimmed)
    } catch (e: any) {
      setError(e.message || '导入失败')
    }
  }

  // 本地文件/文件夹选择:过滤出支持的文档类型后批量导入。
  // 收的是 File[] 而不是 FileList —— 调用处必须先 Array.from 快照再重置 input,
  // 理由见下面 onChange 的注释
  const handleFiles = async (list: File[]) => {
    if (loading) return
    if (list.length === 0) {
      // 选了东西却一个文件都没到手,几乎只可能是取用姿势不对(或者用户取消了选择),
      // 跟「选到了但类型不对」是两码事,分开说才诊断得动
      setError('浏览器没有交出任何文件,请重试')
      return
    }
    const files = list.filter((f) => DOC_EXT.test(f.name))
    if (files.length === 0) {
      setError(`收到 ${list.length} 个文件,其中没有 .md / .markdown / .txt`)
      return
    }
    setError('')
    try {
      await onImportFiles(files, keepTree)
    } catch (e: any) {
      setError(e.message || '导入失败')
    }
  }

  // input 选完要清空 value,否则下次选同一个文件/文件夹不会触发 change。
  // 但 e.target.files 是活引用:Blink 的 FileInputType::SetValue 会就地
  // file_list_->clear(),清空之后先前拿到的那个 FileList 长度直接变 0。
  // 所以必须先 Array.from 快照(File 对象本身在 FileList 被清空后仍然有效)再重置
  const pickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const snapshot = Array.from(e.target.files || [])
    e.target.value = ''
    handleFiles(snapshot)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div className="relative bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-lg font-semibold text-gray-900 mb-1">导入文章</h3>
        <p className="text-sm text-gray-500 mb-4">从网页链接提取正文，或选择本地 Markdown / 文本文档</p>

        {/* 网页导入 */}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && handleSubmit()}
            placeholder="https://example.com/article"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
            disabled={loading}
          />
          <button
            onClick={handleSubmit}
            disabled={loading}
            className="px-4 py-2 bg-emerald-500 text-white text-sm rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors shrink-0"
          >
            {loading && !progress ? (
              <span className="flex items-center gap-2">
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                导入中...
              </span>
            ) : '导入'}
          </button>
        </div>
        <p className="mt-2 text-xs text-gray-400">
          支持大多数新闻、博客、技术文章页面，自动去除导航栏、广告等无关内容。
        </p>

        {/* 本地文档导入 */}
        <div className="mt-4 pt-4 border-t border-gray-100">
          <div className="flex gap-2">
            <label className={`flex-1 flex items-center justify-center gap-2 border border-dashed border-gray-300 rounded-lg py-2.5 text-sm text-gray-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 transition-colors cursor-pointer ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              选择文件
              <input
                type="file"
                multiple
                accept=".md,.markdown,.txt"
                className="hidden"
                disabled={loading}
                onChange={pickFiles}
              />
            </label>
            <label className={`flex-1 flex items-center justify-center gap-2 border border-dashed border-gray-300 rounded-lg py-2.5 text-sm text-gray-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 transition-colors cursor-pointer ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              选择文件夹
              <input
                type="file"
                multiple
                className="hidden"
                disabled={loading}
                {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={pickFiles}
              />
            </label>
          </div>
          <label className={`mt-3 flex items-start gap-2 text-sm text-gray-600 cursor-pointer ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
            <input
              type="checkbox"
              checked={keepTree}
              disabled={loading}
              onChange={e => setKeepTree(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-gray-300 text-emerald-500 focus:ring-emerald-500"
            />
            <span>
              保留文件夹结构
              <span className="block text-xs text-gray-400 mt-0.5">
                子目录会建成对应的子笔记本，同名的直接复用；不勾选则全部平铺到当前笔记本。
              </span>
            </span>
          </label>
          <p className="mt-2 text-xs text-gray-400">
            支持 .md / .markdown / .txt，文件名作为标题，导入到当前笔记本。
            {keepTree
              ? '选中的那层文件夹本身不建笔记本——它的内容直接进当前笔记本，再往下的子目录才建。'
              : '子目录里的文档标题会带上相对路径（如 技术/前端笔记）以免同名混淆。'}
            重复文章自动跳过。
          </p>
        </div>

        {progress && (
          <p className="mt-3 text-sm text-emerald-600 bg-emerald-50 rounded-lg p-2 flex items-center gap-2">
            <span className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin shrink-0" />
            {progress}
          </p>
        )}
        {result && (
          <p className="mt-3 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-2">
            导入完成：{result}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
      </div>
    </div>
  )
}
