import { useEffect, useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { EyeOffIcon } from './ArticleEditor'
import { fmtSize } from '../lib/fmUtils'
import { parseTags } from '../types'
import type { Article } from '../types'

/** 回收站里的笔记本(P14.1) */
export interface TrashNotebook {
  id: number
  name: string
  color?: string
  deleted_at: string
  article_count: number
}

/** 清空回收站的影响预检(P14.1) */
export interface TrashImpact {
  articles: number
  notebooks: number
  files: number
  bytes: number
}

interface Props {
  articles: Article[]
  activeArticle: Article | null
  notebookName?: string
  deletingId?: number | null
  /** 虚拟笔记本(如「我的私有」/标签视图/回收站):只作筛选视图,不提供新建/导入 */
  virtual?: boolean
  /** 回收站模式(P9):恢复/彻底删除/清空,替代常规删除与置顶 */
  trash?: boolean
  /** 回收站里的笔记本(P14.1),整本恢复或彻底删除 */
  trashNotebooks?: TrashNotebook[]
  onSelect: (article: Article) => void
  onCreate: () => void
  onDelete: (id: number) => Promise<any>
  onImport: () => void
  onRestore?: (id: number) => Promise<any>
  onPurge?: (id: number) => Promise<any>
  onEmptyTrash?: () => Promise<any>
  onTogglePin?: (a: Article) => Promise<any>
  onRestoreNotebook?: (id: number) => Promise<any>
  onPurgeNotebook?: (id: number) => Promise<any>
  /** 清空前的只读预检:会连带清掉多少附件。点了「清空」弹确认框时才请求 */
  onTrashImpact?: () => Promise<TrashImpact | null>
}

export default function ArticleList({
  articles, activeArticle, notebookName, deletingId, virtual, trash, trashNotebooks,
  onSelect, onCreate, onDelete, onImport, onRestore, onPurge, onEmptyTrash, onTogglePin,
  onRestoreNotebook, onPurgeNotebook, onTrashImpact,
}: Props) {
  const [confirmId, setConfirmId] = useState<number | null>(null)
  const [purgeId, setPurgeId] = useState<number | null>(null)
  const [confirmEmpty, setConfirmEmpty] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  // 回收站里的笔记本:待确认的整本恢复 / 彻底删除
  const [nbRestore, setNbRestore] = useState<TrashNotebook | null>(null)
  const [nbPurge, setNbPurge] = useState<TrashNotebook | null>(null)
  const [impact, setImpact] = useState<TrashImpact | null>(null)

  // 预检只在确认框弹出时打一次——不占首屏,也不为此常驻一个统计
  useEffect(() => {
    if (!confirmEmpty || !onTrashImpact) return
    setImpact(null)
    let alive = true
    onTrashImpact().then((r) => { if (alive) setImpact(r) })
    return () => { alive = false }
  }, [confirmEmpty, onTrashImpact])

  const formatDate = (d: string) => {
    const date = new Date(d + 'Z')
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    if (diff < 60000) return '刚刚'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
  }

  // 回收站剩余保留天数(30 天自动清除)
  const daysLeft = (deletedAt: string) => {
    const t = Date.parse(deletedAt.includes('T') ? deletedAt : deletedAt.replace(' ', 'T') + 'Z')
    if (Number.isNaN(t)) return null
    return Math.max(0, 30 - Math.floor((Date.now() - t) / 86400000))
  }

  const restore = async (id: number) => {
    if (!onRestore) return
    setBusyId(id)
    try { await onRestore(id) } finally { setBusyId(null) }
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
        <div>
          <h2 className="font-medium text-gray-900 text-sm">{notebookName || '选择笔记本'}</h2>
          <span className="text-xs text-gray-400">
            {articles.length} 篇文章
            {trash && trashNotebooks && trashNotebooks.length > 0 ? ` · ${trashNotebooks.length} 个笔记本` : ''}
            {trash ? ' · 30 天后自动清除' : ''}
          </span>
        </div>
        {trash && (articles.length > 0 || (trashNotebooks?.length ?? 0) > 0) && onEmptyTrash && (
          <button
            onClick={() => setConfirmEmpty(true)}
            className="px-2 py-1 text-xs rounded-lg text-red-500 hover:bg-red-50 transition-colors"
          >
            清空回收站
          </button>
        )}
        {notebookName && !virtual && (
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
        {/* 回收站里的笔记本(P14.1):整本恢复或彻底删除。放在最前面——
            误删一整本才是这批要解决的问题,它不该混在几百篇散装笔记里 */}
        {trash && trashNotebooks && trashNotebooks.length > 0 && (
          <div className="border-b border-gray-100 bg-amber-50/40">
            <p className="px-4 pt-2.5 pb-1 text-[11px] text-amber-700">
              已删除的笔记本 {trashNotebooks.length} 个 · 恢复会把其中仍在回收站的笔记一并带回
            </p>
            {trashNotebooks.map((nb) => {
              const left = daysLeft(nb.deleted_at)
              return (
                <div key={`nb-${nb.id}`} className="px-4 py-2 flex items-center gap-2 group">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ backgroundColor: nb.color || '#10B981' }} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">📓 {nb.name}</p>
                    <p className="text-[11px] text-gray-400">
                      {nb.article_count} 篇笔记{left !== null ? ` · ${left} 天后自动清除` : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => setNbRestore(nb)}
                    className="text-xs px-2 py-1 rounded-lg text-emerald-600 hover:bg-emerald-50 shrink-0"
                  >
                    恢复整本
                  </button>
                  <button
                    onClick={() => setNbPurge(nb)}
                    className="text-xs px-2 py-1 rounded-lg text-red-500 hover:bg-red-50 shrink-0"
                  >
                    彻底删除
                  </button>
                </div>
              )
            })}
          </div>
        )}
        {articles.map((article) => {
          const deleting = deletingId === article.id
          const busy = busyId === article.id
          const tags = parseTags(article.tags)
          return (
          <div
            key={article.id}
            onClick={() => !deleting && onSelect(article)}
            className={`px-4 py-3 border-b border-gray-50 cursor-pointer transition-colors group ${
              deleting || busy ? 'bg-gray-100 opacity-60 pointer-events-none' :
              activeArticle?.id === article.id ? 'bg-emerald-50' : 'hover:bg-gray-50'
            }`}
          >
            <div className="flex items-start justify-between">
              <h3 className={`text-sm font-medium flex items-center gap-1 min-w-0 flex-1 ${
                deleting ? 'text-gray-400' :
                activeArticle?.id === article.id ? 'text-emerald-700' : 'text-gray-900'
              }`}>
                {!trash && !!article.pinned && (
                  <span title="已置顶" className="shrink-0 text-emerald-500 text-xs">📌</span>
                )}
                {article.is_private ? (
                  <span title="私有笔记(不可对外展示)" className="shrink-0 text-amber-500">
                    <EyeOffIcon className="w-3.5 h-3.5" />
                  </span>
                ) : null}
                <span className="truncate">{article.title}</span>
              </h3>
              {deleting || busy ? (
                <span className="flex items-center gap-1 shrink-0 ml-2 text-xs text-gray-400">
                  <span className="w-3.5 h-3.5 border-2 border-gray-300 border-t-transparent rounded-full animate-spin" />
                  {trash ? '处理中' : '删除中'}
                </span>
              ) : trash ? (
                <span className="flex items-center gap-0.5 shrink-0 ml-2 opacity-0 group-hover:opacity-100 max-lg:opacity-100 transition-opacity">
                  <button
                    onClick={(e) => { e.stopPropagation(); restore(article.id) }}
                    title="恢复到原笔记本"
                    className="p-1 rounded hover:bg-emerald-50 text-gray-400 hover:text-emerald-600 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a4 4 0 110 8H7m-4-8l4-4m-4 4l4 4" />
                    </svg>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setPurgeId(article.id) }}
                    title="彻底删除(不可恢复)"
                    className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </span>
              ) : (
                /* 置顶 / 移入回收站:桌面悬浮才出;窄屏没有悬浮,常驻显示 */
                <span className="flex items-center gap-0.5 shrink-0 ml-2 opacity-0 group-hover:opacity-100 max-lg:opacity-100 transition-opacity">
                  {onTogglePin && (
                    <button
                      onClick={(e) => { e.stopPropagation(); onTogglePin(article) }}
                      title={article.pinned ? '取消置顶' : '置顶'}
                      className={`p-1 rounded hover:bg-emerald-50 transition-colors text-xs ${article.pinned ? 'text-emerald-500' : 'text-gray-400 hover:text-emerald-600'}`}
                    >
                      📌
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmId(article.id) }}
                    title="移入回收站"
                    className="p-1 rounded hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
            <p className="text-xs text-gray-400 mt-1 line-clamp-2">
              {(article as any).summary || article.content?.slice(0, 100) || '空文章'}
            </p>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {trash && article.deleted_at ? (
                <>
                  <span className="text-xs text-gray-300">删除于 {formatDate(article.deleted_at)}</span>
                  {daysLeft(article.deleted_at) !== null && (
                    <span className="text-xs text-amber-500">剩 {daysLeft(article.deleted_at)} 天</span>
                  )}
                  {article.notebook && <span className="text-xs text-gray-300">原:{article.notebook}</span>}
                </>
              ) : (
                <>
                  <span className="text-xs text-gray-300">{formatDate(article.updated_at)}</span>
                  {tags.slice(0, 3).map((t) => (
                    <span key={t} className="text-[11px] px-1 py-px rounded bg-gray-100 text-gray-400"># {t}</span>
                  ))}
                  {tags.length > 3 && <span className="text-[11px] text-gray-300">+{tags.length - 3}</span>}
                  {article.is_vectorized ? (
                    <span className="text-xs text-emerald-500 flex items-center gap-0.5">
                      <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      已索引
                    </span>
                  ) : null}
                </>
              )}
            </div>
          </div>
          )
        })}

        {articles.length === 0 && notebookName && (
          <div className="text-center py-12 text-gray-400">
            <p className="text-sm">{trash ? (trashNotebooks && trashNotebooks.length > 0 ? '没有单独删除的笔记' : '回收站是空的') : virtual ? '这里还没有笔记' : '暂无文章'}</p>
            {!virtual && (
              <button onClick={onCreate} className="text-sm text-emerald-500 hover:text-emerald-600 mt-1">
                + 创建第一篇
              </button>
            )}
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
          message="文章将移入回收站,30 天内可恢复;对应的向量索引会即时移除,公开与置顶状态取消。"
          onConfirm={() => { const id = confirmId; setConfirmId(null); onDelete(id) }}
          onCancel={() => setConfirmId(null)}
        />
      )}

      {purgeId !== null && (
        <ConfirmDialog
          title="彻底删除这篇文章？"
          message="文章将从回收站中彻底删除,未被其他笔记引用的附件一并清理,此操作不可恢复。"
          confirmText="彻底删除"
          onConfirm={() => { const id = purgeId; setPurgeId(null); onPurge?.(id) }}
          onCancel={() => setPurgeId(null)}
        />
      )}

      {confirmEmpty && (
        <ConfirmDialog
          title="清空回收站？"
          message={
            impact
              ? `将彻底删除 ${impact.articles} 篇笔记${impact.notebooks > 0 ? ` 与 ${impact.notebooks} 个笔记本` : ''}` +
                (impact.files > 0
                  ? `,并从存储中清理 ${impact.files} 个附件(共 ${fmtSize(impact.bytes)})——这些附件已经没有任何笔记引用,且未被归入文件管理的文件夹。`
                  : ',没有附件会被清理(它们要么仍被别的笔记引用,要么已归入文件管理的文件夹)。') +
                '此操作不可恢复。'
              : `回收站中的 ${articles.length} 篇笔记将被彻底删除,未被引用的附件一并清理,此操作不可恢复。正在统计附件影响…`
          }
          confirmText="全部彻底删除"
          onConfirm={() => { setConfirmEmpty(false); onEmptyTrash?.() }}
          onCancel={() => setConfirmEmpty(false)}
        />
      )}

      {nbRestore && (
        <ConfirmDialog
          title={`恢复「${nbRestore.name}」？`}
          message={`笔记本会回到侧栏,其中仍在回收站的 ${nbRestore.article_count} 篇笔记一并恢复并重建向量索引。若某几篇是你此前单独删掉的,它们也会一起回来——再删一次即可。`}
          confirmText="恢复整本"
          onConfirm={() => { const id = nbRestore.id; setNbRestore(null); onRestoreNotebook?.(id) }}
          onCancel={() => setNbRestore(null)}
        />
      )}

      {nbPurge && (
        <ConfirmDialog
          title={`彻底删除「${nbPurge.name}」？`}
          message={`笔记本与其中 ${nbPurge.article_count} 篇笔记将被永久删除;附件按引用计数清理——只有「已经没有任何笔记引用、且未归入文件管理文件夹」的才会从存储中删除。此操作不可恢复。`}
          confirmText="彻底删除"
          onConfirm={() => { const id = nbPurge.id; setNbPurge(null); onPurgeNotebook?.(id) }}
          onCancel={() => setNbPurge(null)}
        />
      )}
    </div>
  )
}
