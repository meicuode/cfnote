import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { EyeOffIcon } from './ArticleEditor'
import { PRIVATE_NOTEBOOK, TRASH_NOTEBOOK, TAG_VIEW_ID, tagNotebook } from '../types'
import type { Notebook } from '../types'

interface Props {
  notebooks: Notebook[]
  activeNotebook: Notebook | null
  tags: { name: string; count: number }[]
  onSelect: (nb: Notebook) => void
  onCreate: (name: string) => Promise<any>
  onDelete: (id: number) => Promise<any>
  onOpenFiles: () => void
}

const COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#6366F1']

export default function Sidebar({ notebooks, activeNotebook, tags, onSelect, onCreate, onDelete, onOpenFiles }: Props) {
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)

  const handleCreate = async () => {
    if (!newName.trim()) return
    setCreating(true)
    await onCreate(newName.trim())
    setNewName('')
    setShowNew(false)
    setCreating(false)
  }

  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    setContextMenu({ id, x: e.clientX, y: e.clientY })
  }

  const handleDelete = () => {
    if (!contextMenu) return
    setConfirmId(contextMenu.id)
    setContextMenu(null)
  }

  return (
    <div className="h-full flex flex-col py-3" onClick={() => setContextMenu(null)}>
      <div className="px-3 mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">笔记本</span>
        <button
          onClick={() => setShowNew(true)}
          className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
          title="新建笔记本"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* New notebook input */}
      {showNew && (
        <div className="px-3 mb-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCreate()
              if (e.key === 'Escape') { setShowNew(false); setNewName('') }
            }}
            autoFocus
            placeholder="笔记本名称"
            className="w-full text-sm border border-emerald-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            disabled={creating}
          />
        </div>
      )}

      {/* Notebook list */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {notebooks.map((nb) => (
          <button
            key={nb.id}
            onClick={() => onSelect(nb)}
            onContextMenu={(e) => handleContextMenu(e, nb.id)}
            className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg mb-0.5 text-sm transition-colors ${
              activeNotebook?.id === nb.id
                ? 'bg-emerald-50 text-emerald-700 font-medium'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: nb.color }} />
            <span className="truncate flex-1">{nb.name}</span>
            <span className="text-xs text-gray-400">{nb.article_count}</span>
          </button>
        ))}

        {notebooks.length === 0 && !showNew && (
          <p className="text-xs text-gray-400 text-center mt-8 px-4">
            还没有笔记本，点击上方 + 创建一个
          </p>
        )}

        {/* P9 标签区:聚合自笔记 tags,点击进入标签虚拟视图 */}
        {tags.length > 0 && (
          <div className="border-t border-gray-100 mt-2 pt-2">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-3 mb-1">标签</p>
            {tags.map((t) => (
              <button
                key={t.name}
                onClick={() => onSelect(tagNotebook(t.name))}
                className={`w-full text-left flex items-center gap-2 px-2.5 py-1.5 rounded-lg mb-0.5 text-sm transition-colors ${
                  activeNotebook?.id === TAG_VIEW_ID && activeNotebook.name === t.name
                    ? 'bg-emerald-50 text-emerald-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-100'
                }`}
              >
                <span className="text-gray-400 shrink-0">#</span>
                <span className="truncate flex-1">{t.name}</span>
                <span className="text-xs text-gray-400">{t.count}</span>
              </button>
            ))}
          </div>
        )}

        {/* 固定入口:我的私有(虚拟笔记本,筛选所有私有笔记,不可删除) */}
        <div className="border-t border-gray-100 mt-2 pt-2">
          <button
            onClick={() => onSelect(PRIVATE_NOTEBOOK)}
            className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
              activeNotebook?.id === PRIVATE_NOTEBOOK.id
                ? 'bg-amber-50 text-amber-700 font-medium'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
            title="所有标记为私有的笔记"
          >
            <span className="text-amber-500 shrink-0">
              <EyeOffIcon className="w-3.5 h-3.5" />
            </span>
            <span className="truncate flex-1">我的私有</span>
          </button>
          {/* 回收站(P9):软删除的笔记,30 天后自动清除 */}
          <button
            onClick={() => onSelect(TRASH_NOTEBOOK)}
            className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
              activeNotebook?.id === TRASH_NOTEBOOK.id
                ? 'bg-gray-200/70 text-gray-700 font-medium'
                : 'text-gray-700 hover:bg-gray-100'
            }`}
            title="已删除的笔记,30 天后自动清除"
          >
            <span className="text-gray-400 shrink-0">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </span>
            <span className="truncate flex-1">回收站</span>
          </button>
          {/* 文件管理(P8.2):管理应用内全部附件 */}
          <button
            onClick={onOpenFiles}
            className="w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            title="管理全部附件:目录、搜索、预览、清理"
          >
            <span className="text-gray-400 shrink-0">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
            </span>
            <span className="truncate flex-1">文件管理</span>
          </button>
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleDelete}
            className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
          >
            删除笔记本
          </button>
        </div>
      )}

      {confirmId !== null && (
        <ConfirmDialog
          title="删除此笔记本？"
          message="其中的所有文章及其向量索引、附件引用将被彻底删除(不进入回收站),此操作不可撤销。"
          onConfirm={() => { const id = confirmId; setConfirmId(null); onDelete(id) }}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  )
}
