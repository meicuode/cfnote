import { useState, type ReactNode } from 'react'
import ConfirmDialog from './ConfirmDialog'
import TagBrowserDialog from './TagBrowserDialog'
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
  /** 文件管理是否为当前视图,用于高亮 */
  filesActive: boolean
  /** 文件管理二级菜单(P11.6):仅进入文件管理时由 Layout 传入,退出为 null */
  fileNavSlot?: ReactNode
  /** 博客管理当前子视图(null=未打开),用于高亮 */
  blogView: 'articles' | 'comments' | 'layout' | null
  onOpenBlog: (view: 'articles' | 'comments' | 'layout') => void
}

const COLORS = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#EC4899', '#6366F1']

export default function Sidebar({ notebooks, activeNotebook, tags, onSelect, onCreate, onDelete, onOpenFiles, filesActive, fileNavSlot, blogView, onOpenBlog }: Props) {
  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  const [confirmId, setConfirmId] = useState<number | null>(null)
  // P10.4 标签区:折叠(记忆)+ 常用前 N 个 chips + 「全部标签」浏览器
  const [tagsOpen, setTagsOpen] = useState(() => localStorage.getItem('cfnote-tags-open') !== '0')
  const [showTagBrowser, setShowTagBrowser] = useState(false)
  const TAG_CHIP_LIMIT = 10
  const sortedTags = [...tags].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'))
  const topTags = sortedTags.slice(0, TAG_CHIP_LIMIT)
  const activeTagName = activeNotebook?.id === TAG_VIEW_ID ? activeNotebook.name : null
  const toggleTags = () =>
    setTagsOpen((v) => { localStorage.setItem('cfnote-tags-open', v ? '0' : '1'); return !v })

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

        {/* P9/P10.4 标签区:折叠 + 常用前 N 个紧凑 chips(按频次排序)+「全部标签」搜索浏览器 */}
        {tags.length > 0 && (
          <div className="border-t border-gray-100 mt-2 pt-2">
            <button
              onClick={toggleTags}
              className="w-full flex items-center justify-between px-3 mb-1 group"
              title={tagsOpen ? '折叠标签' : '展开标签'}
            >
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                标签 <span className="normal-case">({tags.length})</span>
              </span>
              <svg
                className={`w-3.5 h-3.5 text-gray-300 group-hover:text-gray-500 transition-transform ${tagsOpen ? 'rotate-90' : ''}`}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
            {tagsOpen && (
              <div className="px-2">
                <div className="flex flex-wrap gap-1">
                  {topTags.map((t) => {
                    const active = activeTagName === t.name
                    return (
                      <button
                        key={t.name}
                        onClick={() => onSelect(tagNotebook(t.name))}
                        title={`${t.name}（${t.count}）`}
                        className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md text-xs transition-colors max-w-full ${
                          active
                            ? 'bg-emerald-100 text-emerald-700 font-medium'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        <span className="text-gray-400">#</span>
                        <span className="truncate max-w-[96px]">{t.name}</span>
                        <span className="text-[10px] text-gray-400">{t.count}</span>
                      </button>
                    )
                  })}
                </div>
                {tags.length > TAG_CHIP_LIMIT && (
                  <button
                    onClick={() => setShowTagBrowser(true)}
                    className="mt-1.5 text-xs text-emerald-600 hover:text-emerald-700 transition-colors"
                  >
                    全部标签（{tags.length}）›
                  </button>
                )}
              </div>
            )}
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
          {/* 博客管理(P11):管理所有已公开文章;下挂「评论管理」二级菜单。内联展示于右侧工作区 */}
          <button
            onClick={() => onOpenBlog('articles')}
            className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
              blogView === 'articles' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
            }`}
            title="管理已公开的博客文章"
          >
            <span className={`shrink-0 ${blogView === 'articles' ? 'text-emerald-500' : 'text-gray-400'}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 20.25c4.97 0 9-3.694 9-8.25s-4.03-8.25-9-8.25S3 7.444 3 12c0 2.104.859 4.023 2.273 5.48.432.447.74 1.04.586 1.641a4.483 4.483 0 01-.923 1.785A5.969 5.969 0 006 21c1.282 0 2.47-.402 3.445-1.087.81.22 1.668.337 2.555.337z" />
              </svg>
            </span>
            <span className="truncate flex-1">博客管理</span>
          </button>
          {/* 二级菜单:评论管理(P11.2 审核入口) */}
          <button
            onClick={() => onOpenBlog('comments')}
            className={`w-full text-left flex items-center gap-2.5 pl-8 pr-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
              blogView === 'comments' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
            }`}
            title="审核访客评论:通过/拒绝/回复/删除"
          >
            <span className={`shrink-0 ${blogView === 'comments' ? 'text-emerald-500' : 'text-gray-400'}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
              </svg>
            </span>
            <span className="truncate flex-1">评论管理</span>
          </button>
          {/* 二级菜单:页面布局(P12.1 模块化槽位配置) */}
          <button
            onClick={() => onOpenBlog('layout')}
            className={`w-full text-left flex items-center gap-2.5 pl-8 pr-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
              blogView === 'layout' ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
            }`}
            title="配置博客列表页/详情页的模块与位置"
          >
            <span className={`shrink-0 ${blogView === 'layout' ? 'text-emerald-500' : 'text-gray-400'}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 5h16M4 5v14M4 19h16M20 5v14M14 9v6M14 9H4m10 0h6m-6 6H4m10 0h6" />
              </svg>
            </span>
            <span className="truncate flex-1">页面布局</span>
          </button>
          {/* 文件管理(P8.2):管理应用内全部附件;P11.5 起内联展示于右侧工作区 */}
          <button
            onClick={onOpenFiles}
            className={`w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm transition-colors ${
              filesActive ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
            }`}
            title="管理全部附件:目录、搜索、预览、清理"
          >
            <span className={`shrink-0 ${filesActive ? 'text-emerald-500' : 'text-gray-400'}`}>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
            </span>
            <span className="truncate flex-1">文件管理</span>
          </button>
          {/* 二级菜单(P11.6):全部文件/未引用/笔记附件/我的文件夹,仅进入文件管理时展开 */}
          {fileNavSlot}
          {/* 网页剪藏(P9):打开 /clip 安装引导页(bookmarklet) */}
          <button
            onClick={() => window.open('/clip', '_blank', 'noopener')}
            className="w-full text-left flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-sm text-gray-700 hover:bg-gray-100 transition-colors"
            title="安装浏览器剪藏书签,把网页保存为笔记"
          >
            <span className="text-gray-400 shrink-0">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M7.848 8.25l1.536.887M7.848 8.25a3 3 0 11-5.196-3 3 3 0 015.196 3zm1.536.887a2.165 2.165 0 011.083 1.839c.005.351.054.695.14 1.024M9.384 9.137l2.077 1.199M7.848 15.75l1.536-.887m-1.536.887a3 3 0 11-5.196 3 3 3 0 015.196-3zm1.536-.887a2.165 2.165 0 001.083-1.838c.005-.352.054-.695.14-1.025m-1.223 2.863l2.077-1.199m0-3.328a4.323 4.323 0 012.068-1.379l5.325-1.628a4.5 4.5 0 012.48-.044l.803.215-7.794 4.5m-2.882-.643a4.323 4.323 0 00-.229 2.428m3.111-1.785l7.794 4.5-.802.215a4.5 4.5 0 01-2.48-.043l-5.326-1.629a4.324 4.324 0 01-2.068-1.379m0 0a4.32 4.32 0 01-.229-2.428" />
              </svg>
            </span>
            <span className="truncate flex-1">网页剪藏</span>
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
          title="把此笔记本移入回收站？"
          message="其中的笔记会一并移入回收站,30 天内可整本恢复(向量索引即时移除,公开与置顶取消)。附件不会被删除——要等彻底清除时才按引用计数清理。"
          confirmText="移入回收站"
          onConfirm={() => { const id = confirmId; setConfirmId(null); onDelete(id) }}
          onCancel={() => setConfirmId(null)}
        />
      )}

      {showTagBrowser && (
        <TagBrowserDialog
          tags={tags}
          activeName={activeTagName}
          onPick={(name) => onSelect(tagNotebook(name))}
          onClose={() => setShowTagBrowser(false)}
        />
      )}
    </div>
  )
}
