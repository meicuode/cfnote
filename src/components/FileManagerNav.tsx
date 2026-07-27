// 文件管理二级菜单(P11.6):原为 FileManager 模块内的左栏(w-52),现上移为应用侧栏中
// 「文件管理」下的二级菜单——仅在进入文件管理时展开,退出即收起(侧栏不被文件夹树长期撑长)。
// 内容与原左栏一致:全部文件 / 未引用 / 笔记附件(按笔记本,派生只读)/ 我的文件夹(多级树 + 增删改移)。
// 文件夹相关的三个弹窗随之迁来(仍是 fixed z-[80] 叠层,不受侧栏容器裁剪影响)。

import type { ReactNode } from 'react'
import ConfirmDialog from './ConfirmDialog'
import { buildFolderTree, collectPrivateIds, type FolderNode } from '../lib/fmUtils'
import type { FmView, UseFileManager } from '../hooks/useFileManager'

interface Props {
  view: FmView
  onChangeView: (v: FmView) => void
  fm: UseFileManager
}

export default function FileManagerNav({ view, onChangeView, fm }: Props) {
  const { overview } = fm
  const folderTree = buildFolderTree(overview?.folders || [])
  // 私密子树(「我的私密文件夹」及其后代):锁图标、禁改名/移动/删除
  const privateIds = collectPrivateIds(overview?.folders || [])

  const navItem = (active: boolean, onClick: () => void, content: ReactNode, extra?: ReactNode) => (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-2 pl-8 pr-2.5 py-1.5 rounded-lg text-[13px] transition-colors group ${
        active ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      {content}
      {extra}
    </button>
  )

  const renderFolder = (node: FolderNode, depth: number): ReactNode => (
    <div key={node.id}>
      <div style={{ paddingLeft: depth * 12 }}>
        {navItem(
          view.kind === 'folder' && view.id === node.id,
          () => onChangeView({ kind: 'folder', id: node.id }),
          <>
            <span className="shrink-0">{privateIds.has(node.id) ? '🔒' : '📁'}</span>
            <span
              className="truncate flex-1"
              title={privateIds.has(node.id) ? '私密文件夹:其中的文件禁止公开访问与分享' : undefined}
            >
              {node.name}
            </span>
          </>,
          <span className="hidden group-hover:flex items-center gap-0.5 shrink-0">
            <span
              role="button"
              title="新建子目录"
              onClick={(e) => { e.stopPropagation(); fm.setFolderInput({ parent: node.id, parentName: node.name }); fm.setFolderName('') }}
              className="p-0.5 rounded hover:bg-gray-200 text-gray-400"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M12 4v16m8-8H4" /></svg>
            </span>
            {/* 系统私密根目录不可改名/移动/删除,只留新建子目录 */}
            {!node.is_private && (
              <>
                <span
                  role="button"
                  title="重命名"
                  onClick={(e) => { e.stopPropagation(); fm.setFolderRename(node); fm.setFolderRenameVal(node.name) }}
                  className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
                >
                  ✏️
                </span>
                <span
                  role="button"
                  title="移动到其他文件夹"
                  onClick={(e) => { e.stopPropagation(); fm.setFolderMove(node) }}
                  className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
                >
                  ⇄
                </span>
                <span
                  role="button"
                  title="删除(须为空)"
                  onClick={(e) => { e.stopPropagation(); fm.setFolderDelete(node) }}
                  className="p-0.5 rounded hover:bg-gray-200 text-gray-400 text-xs"
                >
                  🗑
                </span>
              </>
            )}
          </span>
        )}
      </div>
      {node.children.map((ch) => renderFolder(ch, depth + 1))}
    </div>
  )

  return (
    <div className="mb-1">
      {navItem(view.kind === 'all', () => onChangeView({ kind: 'all' }), <><span className="shrink-0">🗂</span><span className="flex-1">全部文件</span></>)}
      {navItem(
        view.kind === 'unref',
        () => onChangeView({ kind: 'unref' }),
        <><span className="shrink-0">🧹</span><span className="flex-1">未引用</span></>,
        overview && overview.unref_count > 0 ? <span className="text-[11px] text-gray-400">{overview.unref_count}</span> : undefined
      )}

      <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider pl-8 mt-2 mb-0.5">笔记附件</p>
      {(overview?.notebooks || []).map((nb) =>
        <div key={nb.id}>
          {navItem(
            view.kind === 'notebook' && view.id === nb.id,
            () => onChangeView({ kind: 'notebook', id: nb.id }),
            <>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: nb.color }} />
              <span className="truncate flex-1">{nb.name}</span>
            </>,
            <span className="text-[11px] text-gray-400 shrink-0">{nb.file_count}</span>
          )}
        </div>
      )}
      {overview && overview.notebooks.length === 0 && (
        <p className="text-[11px] text-gray-400 pl-8 py-1">笔记里还没有附件</p>
      )}

      <div className="flex items-center justify-between pl-8 pr-2.5 mt-2 mb-0.5">
        <p className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider">我的文件夹</p>
        <button
          onClick={() => { fm.setFolderInput({ parent: null }); fm.setFolderName('') }}
          className="p-0.5 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600"
          title="新建文件夹"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" d="M12 4v16m8-8H4" /></svg>
        </button>
      </div>
      {fm.folderInput && (
        <div className="pl-8 pr-2.5 mb-1.5">
          {fm.folderInput.parentName && <p className="text-[11px] text-gray-400 mb-0.5">在「{fm.folderInput.parentName}」下:</p>}
          <input
            autoFocus
            value={fm.folderName}
            onChange={(e) => fm.setFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') fm.submitFolderCreate()
              if (e.key === 'Escape') fm.setFolderInput(null)
            }}
            onBlur={() => { if (!fm.folderName.trim()) fm.setFolderInput(null) }}
            placeholder="文件夹名称"
            className="w-full text-xs border border-emerald-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
          />
        </div>
      )}
      {folderTree.map((n) => renderFolder(n, 0))}
      {overview && folderTree.length === 0 && !fm.folderInput && (
        <p className="text-[11px] text-gray-400 pl-8 py-1">手工上传的文件可归入文件夹</p>
      )}

      {/* ---- 文件夹弹窗(fixed 叠层,不受侧栏容器限制)---- */}

      {/* 移动文件夹(排除自身及其子树;移入私密子树会取消其中文件的分享) */}
      {fm.folderMove && (() => {
        const moving = fm.folderMove
        const excluded = new Set<number>()
        const walk = (n: FolderNode) => { excluded.add(n.id); n.children.forEach(walk) }
        walk(moving)
        return (
          <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => fm.setFolderMove(null)}>
            <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
              <h3 className="text-sm font-semibold text-gray-900 mb-1">移动文件夹「{moving.name}」</h3>
              <p className="text-[11px] text-gray-400 mb-2">
                移动不影响任何文件链接。移入 🔒 私密文件夹后,其中所有文件禁止公开,已有分享会被取消。
              </p>
              <div className="max-h-60 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
                <button
                  onClick={() => fm.submitFolderMove(null)}
                  disabled={moving.parent_id == null}
                  className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50 disabled:opacity-40"
                >
                  (移到根目录)
                </button>
                {(function flat(nodes: FolderNode[], depth: number): ReactNode[] {
                  return nodes.flatMap((n) => {
                    if (excluded.has(n.id)) return []
                    return [
                      <button
                        key={n.id}
                        onClick={() => fm.submitFolderMove(n.id)}
                        disabled={moving.parent_id === n.id}
                        className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50 disabled:opacity-40"
                        style={{ paddingLeft: 12 + depth * 16 }}
                      >
                        {privateIds.has(n.id) ? '🔒' : '📁'} {n.name}
                      </button>,
                      ...flat(n.children, depth + 1),
                    ]
                  })
                })(folderTree, 0)}
              </div>
            </div>
          </div>
        )
      })()}

      {/* 文件夹重命名 */}
      {fm.folderRename && (
        <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center" onMouseDown={() => fm.setFolderRename(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-2">重命名文件夹</h3>
            <input
              autoFocus
              value={fm.folderRenameVal}
              onChange={(e) => fm.setFolderRenameVal(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') fm.submitFolderRename(); if (e.key === 'Escape') fm.setFolderRename(null) }}
              className="w-full text-sm border border-gray-200 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={() => fm.setFolderRename(null)} className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100">取消</button>
              <button onClick={fm.submitFolderRename} className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600">确定</button>
            </div>
          </div>
        </div>
      )}

      {/* 删除文件夹确认(空目录);删掉当前所在目录时视图回落「全部文件」 */}
      {fm.folderDelete && (
        <ConfirmDialog
          title={`删除文件夹「${fm.folderDelete.name}」？`}
          message="仅能删除空文件夹;若其中还有文件或子目录会被拒绝。"
          onConfirm={async () => {
            const deletedId = await fm.submitFolderDelete()
            if (deletedId != null && view.kind === 'folder' && view.id === deletedId) onChangeView({ kind: 'all' })
          }}
          onCancel={() => fm.setFolderDelete(null)}
        />
      )}
    </div>
  )
}
