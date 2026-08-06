// 文件管理二级菜单(P11.6 建,P17.3 大幅收窄)。
//
// 此前这里挂着三段会随数据无限增长的内容:按笔记本列的「笔记附件」、多级文件夹树、
// 以及拖拽落点。它们和笔记本树抢应用侧栏那一个滚动区——文件夹一多,下面的
//「网页剪藏」就被顶到看不见的地方,而要点中文件夹行尾那三个 12px 的小图标
// 本来就是整个应用里最难的操作。
//
// 现在只剩四个**高度恒定**的入口,文件夹树与笔记附件都搬进右侧主窗口
// (见 FileManager.tsx;为什么笔记附件不做成树,见 DESIGN §10 P17.3)。
// 文件夹的增删改移弹窗一并迁走——它们本来就是 fixed 叠层,挂在哪棵组件树上都一样,
// 而现在触发它们的入口全在主窗口里。

import type { ReactNode } from 'react'
import type { FmView, UseFileManager } from '../hooks/useFileManager'

interface Props {
  view: FmView
  onChangeView: (v: FmView) => void
  fm: UseFileManager
}

export default function FileManagerNav({ view, onChangeView, fm }: Props) {
  const { overview } = fm

  const navItem = (active: boolean, onClick: () => void, icon: string, label: string, badge?: ReactNode) => (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-2 pl-8 pr-2.5 py-1.5 rounded-lg text-[13px] transition-colors ${
        active ? 'bg-emerald-50 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate flex-1">{label}</span>
      {badge}
    </button>
  )

  const dim = <span className="text-[11px] text-gray-400 shrink-0" />

  return (
    <div className="mb-1">
      {navItem(view.kind === 'all', () => onChangeView({ kind: 'all' }), '🗂', '全部文件',
        overview ? <span className="text-[11px] text-gray-400 shrink-0">{overview.stats.count}</span> : dim)}
      {navItem(view.kind === 'unref', () => onChangeView({ kind: 'unref' }), '🧹', '未引用',
        overview && overview.unref_count > 0
          ? <span className="text-[11px] text-gray-400 shrink-0">{overview.unref_count}</span> : dim)}
      {/* 笔记附件:进去是平铺列表 + 按笔记本筛的 chips,不再在这里展开成一棵树 */}
      {navItem(view.kind === 'notebook', () => onChangeView({ kind: 'notebook', id: null }), '📎', '笔记附件')}
      {/* 我的文件夹:进去是根层,子目录在主窗口里逐层进 */}
      {navItem(view.kind === 'folder', () => onChangeView({ kind: 'folder', id: null }), '📁', '我的文件夹')}
    </div>
  )
}
