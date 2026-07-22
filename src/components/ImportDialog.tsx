import { useState, useEffect, useRef } from 'react'

interface Props {
  loading: boolean
  progress?: string
  onImport: (url: string) => Promise<void>
  onImportFiles: (files: File[]) => Promise<void>
  onClose: () => void
}

const DOC_EXT = /\.(md|markdown|txt)$/i

export default function ImportDialog({ loading, progress, onImport, onImportFiles, onClose }: Props) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
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

  // 本地文件/文件夹选择:过滤出支持的文档类型后批量导入
  const handleFiles = async (list: FileList | null) => {
    if (!list || loading) return
    const files = Array.from(list).filter((f) => DOC_EXT.test(f.name))
    if (files.length === 0) {
      setError('所选内容中没有 .md / .markdown / .txt 文件')
      return
    }
    setError('')
    try {
      await onImportFiles(files)
    } catch (e: any) {
      setError(e.message || '导入失败')
    }
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
                onChange={(e) => { const fl = e.target.files; e.target.value = ''; handleFiles(fl) }}
              />
            </label>
            <label className={`flex-1 flex items-center justify-center gap-2 border border-dashed border-gray-300 rounded-lg py-2.5 text-sm text-gray-600 hover:border-emerald-400 hover:bg-emerald-50 hover:text-emerald-700 transition-colors cursor-pointer ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              选择文件夹
              <input
                type="file"
                className="hidden"
                disabled={loading}
                {...({ webkitdirectory: '', directory: '' } as any)}
                onChange={(e) => { const fl = e.target.files; e.target.value = ''; handleFiles(fl) }}
              />
            </label>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            支持 .md / .markdown / .txt，文件名作为标题，导入到当前笔记本；文件夹会递归读取全部支持的文档，重复文章自动跳过。
          </p>
        </div>

        {progress && (
          <p className="mt-3 text-sm text-emerald-600 bg-emerald-50 rounded-lg p-2 flex items-center gap-2">
            <span className="w-4 h-4 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin shrink-0" />
            {progress}
          </p>
        )}
        {error && <p className="mt-3 text-sm text-red-600 bg-red-50 rounded-lg p-2">{error}</p>}
      </div>
    </div>
  )
}
