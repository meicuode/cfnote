import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { Article } from '../types'

interface Props {
  articles: Article[]
  activeArticle: Article | null
  notebookName?: string
  deletingId?: number | null
  onSelect: (article: Article) => void
  onCreate: () => void
  onDelete: (id: number) => Promise<any>
  onImport: () => void
}

export default function ArticleList({ articles, activeArticle, notebookName, deletingId, onSelect, onCreate, onDelete, onImport }: Props) {
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const formatDate = (d: string) => {
    const date = new Date(d + 'Z')
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div>
          <h2 className="font-medium text-gray-900 text-sm">{notebookName || '选择笔记本'}</h2>
          <span className="text-xs text-gray-400">{articles.length} 篇文章</span>
        </div>
        {notebookName && (
          <div className="flex items-center gap-1">
            <button
              onClick={onImport}
              className="p-1.5 rounded-lg hover:bg-blue-50 text-blue-500 transition-colors"
              title="导入文章(网页 / 本地文档)"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </button>
            <button
              onClick={onCreate}
              className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600 transition-colors"
              title="新建文章"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Article list */}
      <div className="flex-1 overflow-y-auto">
        {articles.map((article) => {
          const deleting = deletingId === article.id
          return (
          <div
            key={article.id}
            onClick={() => !deleting && onSelect(article)}
            className={`px-4 py-3 border-b border-gray-50 cursor-pointer transition-colors group ${
              deleting ? 'bg-gray-100 opacity-60 pointer-events-none' :
              activeArticle?.id === article.id ? 'bg-emerald-50' : 'hover:bg-gray-50'
            }`}
          >
            <div className="flex items-start justify-between">
              <h3 className={`text-sm font-medium truncate flex-1 ${
                deleting ? 'text-gray-400' :
                activeArticle?.id === article.id ? 'text-emerald-700' : 'text-gray-900'
              }`}>
                {article.title}
              </h3>
              {deleting ? (
                <span className="flex items-center gap-1 shrink-0 ml-2 text-xs text-gray-400">
                  <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
                  删除中
                </span>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setConfirmId(article.id)
                  }}
                  className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 text-gray-400 hover:text-red-500 transition-all shrink-0 ml-2"
                >
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1 line-clamp-2">
              {(article as any).summary || article.content?.slice(0, 100) || '空文章'}
            </p>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs text-gray-300">{formatDate(article.updated_at)}</span>
              {article.is_vectorized ? (
                <span className="text-xs text-emerald-500 flex items-center gap-0.5">
                  <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  已索引
                </span>
              ) : null}
            </div>
          </div>
          )
        })}

        {articles.length === 0 && notebookName && (
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">暂无文章</p>
            <button onClick={onCreate} className="text-sm text-emerald-500 hover:text-emerald-600 mt-1">
              + 创建第一篇
            </button>
          </div>
        )}

        {!notebookName && (
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">请先选择笔记本</p>
          </div>
        )}
      </div>

      {confirmId !== null && (
        <ConfirmDialog
          title="删除这篇文章？"
          message="文章内容与对应的向量索引将被一并删除，此操作不可撤销。"
          onConfirm={() => { const id = confirmId; setConfirmId(null); onDelete(id) }}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  )
}
