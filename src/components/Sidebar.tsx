import { useState } from 'react'
import ConfirmDialog from './ConfirmDialog'
import type { Notebook } from '../types'

interface Props {
  notebooks: Notebook[]
  activeNotebook: Notebook | null
  onSelect: (nb: Notebook) => void
  onCreate: (name: string) => Promise<any>
  onDelete: (id: number) => Promise<any>
}

const COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#6366F1']

export default function Sidebar({ notebooks, activeNotebook, onSelect, onCreate, onDelete }: Props) {
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
          message="其中的所有文章及其向量索引将被一并删除，此操作不可撤销。"
          onConfirm={() => { const id = confirmId; setConfirmId(null); onDelete(id) }}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </div>
  )
}
