import { useState, type ReactNode } from 'react'
import ConfirmDialog from './ConfirmDialog'
import TagBrowserDialog from './TagBrowserDialog'
import { EyeOffIcon } from './ArticleEditor'
import { PRIVATE_NOTEBOOK, TRASH_NOTEBOOK, TAG_VIEW_ID, tagNotebook } from '../types'
import { buildTree, descendantIds, inPrivateBranch, privacySource, siblingNameTaken, type TreeNode } from '../lib/notebookTree'
import { menuPosition } from '../lib/fmUtils'
import { deleteNotebookPrompt, type DeletePrompt } from '../lib/deleteNotebook'
import type { Notebook } from '../types'

interface Props {
  notebooks: Notebook[]
  activeNotebook: Notebook | null
  tags: { name: string; count: number }[]
  onSelect: (nb: Notebook) => void
  /** parent 为 null 表示建在根上(P16.1) */
  onCreate: (name: string, parent: number | null) => Promise<any>
  onDelete: (id: number) => Promise<any>
  /** P16.1 移动笔记本:parent 为 null 表示移到根 */
  onMove: (id: number, parent: number | null) => Promise<any>
  /** P17.1 重命名。后端 PUT /api/notebooks/:id 一直支持,只是此前没有入口 */
  onRename: (id: number, name: string) => Promise<any>
  /** P16.5 私密笔记本:只改标志位,服务端会把整支已有笔记一并上锁 */
  onSetPrivate: (id: number, isPrivate: boolean) => Promise<any>
  /** 设为私密 / 删除之前的后果清单(P16.3 起两处共用同一个接口) */
  onPrivateImpact: (id: number) => Promise<{
    ok: boolean
    data?: { notebooks: number; articles: number; published: number; shared: number; private: number; total: number }
  }>
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

/** 缩进到第 6 层封顶:再深就把名字挤没了,层级关系靠展开状态已经能看清 */
const INDENT_PX = 12
const MAX_INDENT_DEPTH = 6

// 右键菜单的尺寸。与文件管理那个(P13.8)同一套量纲,只是条目更少更窄——
// 这里最长的一条是「新建子笔记本」六个字,160 够放,不必跟着它的 184。
// 高度要算出来才能定翻转方向,而「先渲染再量再挪」会闪一帧
const NB_MENU_W = 160
const NB_MENU_PAD = 8
const NB_MENU_ITEM_H = 30
/** 五个条目 + 一条分隔线(按 9px ≈ 0.3 个条目高算进去) */
const NB_MENU_ITEMS = 5.3

/**
 * 笔记本图标(P16.5.2):封面 + 深一档的书脊,整体取笔记本自己的颜色。
 *
 * 换掉原来那个小色块,但**颜色必须留着**——那是用户给每本笔记本设的属性,
 * 不能因为换了个图形就丢掉。
 *
 * 刻意**不用「敞开/合上」区��公开与私密**:这是安全信号,14 像素下开合两种书形
 * 很难一眼分清,而锁的轮廓在任何尺寸下都不会认错——认错的代价是把该私密的当成公开的。
 * 何况开/合在树形侧栏里的既定含义是展开/折叠,与右边的锁标记也会重复编码同一件事。
 */
function NotebookIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 16 16" className="w-4 h-4 shrink-0" style={{ color }} aria-hidden="true">
      <rect x="3" y="1.5" width="10.5" height="13" rx="1.5" fill="currentColor" />
      <rect x="3" y="1.5" width="3" height="13" rx="1.5" fill="currentColor" opacity="0.55" />
    </svg>
  )
}

export default function Sidebar({ notebooks, activeNotebook, tags, onSelect, onCreate, onDelete, onMove, onRename, onSetPrivate, onPrivateImpact, onOpenFiles, filesActive, fileNavSlot, blogView, onOpenBlog }: Props) {
  const [showNew, setShowNew] = useState<{ parent: number | null } | null>(null)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ id: number; x: number; y: number } | null>(null)
  // P17.1 就地重命名:renaming 是那一行的 id,renameName 是输入框里的值
  const [renaming, setRenaming] = useState<number | null>(null)
  const [renameName, setRenameName] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [delAsk, setDelAsk] = useState<{ id: number; prompt: DeletePrompt } | null>(null)
  const [moving, setMoving] = useState<number | null>(null)
  // P16.5 上锁确认:设为私密 / 移进私密分支之前摊开后果,确认即强制,没有「只锁新的」
  const [lockAsk, setLockAsk] = useState<{
    id: number
    name: string
    impact: { notebooks: number; articles: number; published: number; shared: number; private: number }
    run: () => Promise<any>
  } | null>(null)
  // 取消私密的解释框(不是安全闸门,见 handleTogglePrivate)
  const [unlockAsk, setUnlockAsk] = useState<{ id: number; name: string; kept: number } | null>(null)
  // P16.1 展开态:记住哪几本是展开的(存 id 列表,跟文件管理二级菜单同样的持久化做法)
  const [expanded, setExpanded] = useState<Set<number>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem('cfnote-nb-expanded') || '[]')
      return new Set(Array.isArray(raw) ? raw.map(Number).filter(Number.isFinite) : [])
    } catch {
      return new Set<number>()
    }
  })
  const toggleExpand = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('cfnote-nb-expanded', JSON.stringify([...next]))
      return next
    })

  const tree = buildTree(notebooks)

  // 移动的候选:排除自己与自己的全部子孙(选了就成环)。摊平成带 depth 的列表以便缩进显示。
  // 服务端 PUT /notebooks/:id 会用同一个 wouldCycle 再判一次——这里只是别让用户点到
  const moveTargets: { nb: Notebook; depth: number }[] = []
  if (moving !== null) {
    const banned = new Set([moving, ...descendantIds(notebooks, moving)])
    const walk = (ns: TreeNode<Notebook>[]) => {
      for (const n of ns) {
        if (banned.has(n.nb.id)) continue
        moveTargets.push({ nb: n.nb, depth: n.depth })
        walk(n.children)
      }
    }
    walk(tree)
  }
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
    if (!newName.trim() || !showNew) return
    setCreating(true)
    const parent = showNew.parent
    await onCreate(newName.trim(), parent)
    // 在子层建的,把父本自动展开,否则新建完看不见
    if (parent !== null && !expanded.has(parent)) toggleExpand(parent)
    setNewName('')
    setShowNew(null)
    setCreating(false)
  }

  const handleContextMenu = (e: React.MouseEvent, id: number) => {
    e.preventDefault()
    setContextMenu({ id, x: e.clientX, y: e.clientY })
  }

  // ---- P17.1 就地重命名 ----

  const startRename = (id: number) => {
    setContextMenu(null)
    setRenaming(id)
    setRenameName(notebooks.find((n) => n.id === id)?.name || '')
  }

  const cancelRename = () => { setRenaming(null); setRenameName('') }

  /**
   * 提交改名。**同级重名放行、只提示**——服务端没有唯一约束,重名不会让任何
   * 现有功能出错,拦下来反而是凭空造一条规则。要说的是那个延迟的后果:
   * 导入按完整路径匹配(P16.3.1),两本同级同名会算出同一条路径。提示在输入框
   * 底下常驻显示,看见了还按 Enter 就是知情的选择。
   *
   * 没改、或者只改了首尾空白 → 什么都不发:改名是最容易「点进去又退出来」的操作,
   * 每次都发一趟 PUT 等于把免费额度里最紧的请求数花在没有变化的写入上。
   */
  const commitRename = async () => {
    if (renaming === null || renameBusy) return
    const name = renameName.trim()
    const cur = notebooks.find((n) => n.id === renaming)
    if (!name || !cur || name === cur.name) { cancelRename(); return }
    setRenameBusy(true)
    try {
      await onRename(renaming, name)
      cancelRename()
    } finally {
      setRenameBusy(false)
    }
  }

  const handleDelete = () => {
    if (!contextMenu) return
    void askThenDelete(contextMenu.id)
  }

  /**
   * 删除笔记本之前,先把后果摊开(P16.3)。
   *
   * P16.1 时有子本就直接拒绝,因为「删父连子孙一起进、恢复时整棵回来」还没做;
   * 现在恢复侧补齐了,级联才敢开——代价是误点一次会带走一整棵树,所以这个确认框
   * 是这批唯一必须做的 UI:摊开「其中几篇已发布会从博客下线」,超过阈值还要打字确认。
   * 文案与强度判定在 src/lib/deleteNotebook.ts(纯函数 + 单测)——
   * 「published 为 0 时那句该消失」这种分支埋在 JSX 里就只能靠人眼复核。
   */
  const askThenDelete = async (id: number) => {
    setContextMenu(null)
    const name = notebooks.find((x) => x.id === id)?.name || ''
    const res = await onPrivateImpact(id)
    const d = res.ok ? res.data : undefined
    setDelAsk({
      id,
      prompt: deleteNotebookPrompt(name, {
        notebooks: d?.notebooks ?? 1,
        // total = 未私有 + 已私有:进回收站的是全部,不只是能被别人看见的那些
        articles: d?.total ?? 0,
        published: d?.published ?? 0,
        shared: d?.shared ?? 0,
      }),
    })
  }

  /**
   * 设为私密 / 移进私密分支之前,先把后果摊开(P16.5)。
   *
   * 顺序是**先问后做**,不是先做再问要不要补救:确认之后服务端会把整支已有笔记
   * 无条件上锁,没有「只锁新的」这个选项——那会留下「笔记本挂着锁、老笔记全是敞的」,
   * 而侧栏一排锁图标里混一个没锁的根本看不出来。
   * 真正要让人看见的不是总篇数,是**其中几篇已公开、几个分享链接**:那才是别人
   * 看得见、确认之后会当场消失的东西。都是 0 就不打扰,直接做。
   */
  const askThenLock = async (id: number, run: () => Promise<any>) => {
    const res = await onPrivateImpact(id)
    const d = res.ok ? res.data : undefined
    if (!d || (d.published === 0 && d.shared === 0 && d.articles === 0)) {
      await run()
      return
    }
    setLockAsk({ id, name: notebooks.find((x) => x.id === id)?.name || '', impact: d, run })
  }

  const handleTogglePrivate = async (id: number, next: boolean) => {
    setContextMenu(null)
    if (next) {
      await askThenLock(id, () => onSetPrivate(id, true))
      return
    }
    // 取消私密要弹的**不是安全闸门**(这个动作即时可逆,再点回去就是了),是**解释**:
    // 已有笔记不会跟着解锁,于是会留下「笔记本没锁、里面全是私有」这个乍看很怪的状态;
    // 而且真正的风险是延迟的——之后新写进来的笔记不再自动私有,你不会注意到。
    // 里面一篇私有笔记都没有就没什么可解释的,直接做。
    const res = await onPrivateImpact(id)
    const kept = res.ok ? res.data?.private ?? 0 : 0
    if (kept === 0) { await onSetPrivate(id, false); return }
    setUnlockAsk({ id, name: notebooks.find((x) => x.id === id)?.name || '', kept })
  }

  const handleMove = async (id: number, parent: number | null) => {
    setMoving(null)
    // 挪进私密分支等同于设为私密,同样先问;挪出去不问也不解锁
    if (parent !== null && inPrivateBranch(notebooks, parent)) {
      await askThenLock(id, () => onMove(id, parent))
      return
    }
    await onMove(id, parent)
  }

  const newNameInput = (
    <input
      type="text"
      value={newName}
      onChange={(e) => setNewName(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') handleCreate()
        if (e.key === 'Escape') { setShowNew(null); setNewName('') }
      }}
      autoFocus
      placeholder="笔记本名称"
      className="w-full text-sm border border-emerald-300 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-emerald-500"
      disabled={creating}
    />
  )

  /** 递归渲染一层。展开态只影响子层的显隐,自身永远渲染 */
  const renderNode = (node: TreeNode<Notebook>): ReactNode => {
    const { nb, depth, children } = node
    const open = expanded.has(nb.id)
    const pad = 10 + Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX
    // 自己标的锁是实的,从上级继承来的是淡的 —— 一眼能看出「这锁能不能在这儿解」
    const priv = privacySource(notebooks, nb.id)

    // P17.1 就地编辑:整行换成输入框,与资源管理器/VS Code 一致——
    // 改完立刻在树里看到结果,不必在弹窗与侧栏之间对照
    if (renaming === nb.id) {
      const dup = siblingNameTaken(notebooks, nb.id, renameName, nb.parent_id)
      return (
        <div key={nb.id} className="mb-0.5" style={{ paddingLeft: pad + 16, paddingRight: 8 }}>
          <input
            type="text"
            value={renameName}
            onChange={(e) => setRenameName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') cancelRename()
            }}
            // 失焦即提交:改完点别处走人是最自然的收尾,而「改了字但没生效」
            // 在树形侧栏里毫无提示——你看到的还是旧名字,以为改过了
            onBlur={commitRename}
            autoFocus
            // 选中全部而不是把光标放末尾:重命名多半是整个换掉
            onFocus={(e) => e.currentTarget.select()}
            disabled={renameBusy}
            className={`w-full text-sm border rounded px-2 py-1 focus:outline-none focus:ring-1 ${
              dup ? 'border-amber-400 focus:ring-amber-400' : 'border-emerald-300 focus:ring-emerald-500'
            }`}
          />
          {dup && (
            <p className="text-[11px] text-amber-600 mt-0.5 leading-snug">
              同级已有一本叫「{renameName.trim()}」，导入时按路径匹配会分不清这两本
            </p>
          )}
        </div>
      )
    }

    return (
      <div key={nb.id}>
        <div
          onContextMenu={(e) => handleContextMenu(e, nb.id)}
          className={`group w-full flex items-center gap-1 rounded-lg mb-0.5 text-sm transition-colors ${
            activeNotebook?.id === nb.id
              ? 'bg-emerald-50 text-emerald-700 font-medium'
              : 'text-gray-700 hover:bg-gray-100'
          }`}
          style={{ paddingLeft: pad }}
        >
          {/* 无子本时占位等宽,免得同级的圆点参差不齐 */}
          {children.length > 0 ? (
            <button
              onClick={(e) => { e.stopPropagation(); toggleExpand(nb.id) }}
              className="p-0.5 -ml-0.5 rounded text-gray-300 hover:text-gray-600 shrink-0"
              title={open ? '折叠' : '展开'}
              aria-label={open ? '折叠' : '展开'}
            >
              <svg className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <button
            onClick={() => onSelect(nb)}
            // 双击改名(P17.1)。展开/折叠挂在左边那个箭头上,双击这里没有别的既定含义
            onDoubleClick={(e) => { e.preventDefault(); startRename(nb.id) }}
            // F2 是 Windows 的既定改名键。选中的那一本才响应——键盘焦点在哪一行,
            // 改的就是哪一行,不必再引入一个「当前高亮」的概念
            onKeyDown={(e) => { if (e.key === 'F2') { e.preventDefault(); startRename(nb.id) } }}
            className="flex-1 min-w-0 text-left flex items-center gap-2.5 py-2 pr-1"
          >
            <NotebookIcon color={nb.color} />
            <span className="truncate flex-1">{nb.name}</span>
            {priv !== 'none' && (
              <span
                className={`shrink-0 ${priv === 'self' ? 'text-amber-500' : 'text-amber-300'}`}
                title={priv === 'self' ? '私密笔记本:新写进来的笔记自动私有' : '随上级私密:新写进来的笔记自动私有'}
              >
                <EyeOffIcon className="w-3.5 h-3.5" />
              </span>
            )}
            <span className="text-xs text-gray-400">{nb.article_count}</span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setShowNew({ parent: nb.id }); setNewName('') }}
            className="p-1 mr-1 rounded text-gray-300 hover:text-emerald-600 hover:bg-emerald-50 opacity-0 group-hover:opacity-100 max-lg:opacity-100 shrink-0 transition-opacity"
            title="在此新建子笔记本"
            aria-label="在此新建子笔记本"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        {showNew?.parent === nb.id && (
          <div className="mb-1" style={{ paddingLeft: pad + INDENT_PX + 16, paddingRight: 8 }}>
            {newNameInput}
          </div>
        )}
        {open && children.map(renderNode)}
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col py-3" onClick={() => setContextMenu(null)}>
      <div className="px-3 mb-3 flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">笔记本</span>
        <button
          onClick={() => { setShowNew({ parent: null }); setNewName('') }}
          className="p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-gray-600 transition-colors"
          title="新建笔记本(建在最外层)"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>

      {/* 新建在最外层:建在子层的输入框由 renderNode 就地渲染 */}
      {showNew?.parent === null && (
        <div className="px-3 mb-2">{newNameInput}</div>
      )}

      {/* 笔记本树(P16.1):层级由 parent_id 决定,展开态记在 localStorage */}
      <div className="flex-1 overflow-y-auto px-1.5">
        {tree.map(renderNode)}

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

      {/* 右键菜单。宽度、间距、落点翻转全部对齐文件管理那个(P13.8),
          它早就把这几件事做对了,而这边是 P16.1 随手写的:px-4 py-2 + whitespace-nowrap,
          宽度被最长那条「取消私密笔记本」撑开,而且贴着屏幕底部右键时有一半在视口外 */}
      {contextMenu && (() => {
        const priv = privacySource(notebooks, contextMenu.id)
        const pos = menuPosition(
          contextMenu.x, contextMenu.y, NB_MENU_W, NB_MENU_PAD * 2 + NB_MENU_ITEMS * NB_MENU_ITEM_H,
          window.innerWidth, window.innerHeight,
        )
        return (
        <div
          className="fixed py-1 rounded-xl bg-white border border-gray-100 shadow-2xl z-50"
          style={{ left: pos.x, top: pos.y, width: NB_MENU_W }}
        >
          <button
            onClick={() => startRename(contextMenu.id)}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-emerald-50 flex items-center gap-2 transition-colors"
          >
            <span className="w-4 shrink-0 text-xs text-center">✏️</span>
            <span className="truncate">重命名</span>
          </button>
          <button
            onClick={() => { setShowNew({ parent: contextMenu.id }); setNewName(''); setContextMenu(null) }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-emerald-50 flex items-center gap-2 transition-colors"
          >
            <span className="w-4 shrink-0 text-xs text-center">➕</span>
            <span className="truncate">新建子笔记本</span>
          </button>
          <button
            onClick={() => { setMoving(contextMenu.id); setContextMenu(null) }}
            className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-emerald-50 flex items-center gap-2 transition-colors"
          >
            <span className="w-4 shrink-0 text-xs text-center">📂</span>
            <span className="truncate">移动到…</span>
          </button>
          {/* P16.5:继承来的私有不能在这一层解——要解就去标了私有的那个祖先上解 */}
          {priv === 'inherited' ? (
            <button
              disabled
              className="w-full text-left px-3 py-1.5 text-sm text-gray-300 flex items-center gap-2"
              title="它的上级是私密笔记本;要取消请到标了私有的那一本上操作"
            >
              <span className="w-4 shrink-0 text-xs text-center">🔒</span>
              <span className="truncate">已随上级私密</span>
            </button>
          ) : (
            <button
              onClick={() => handleTogglePrivate(contextMenu.id, priv !== 'self')}
              className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-emerald-50 flex items-center gap-2 transition-colors"
              title="私密笔记本:之后写进这一支的笔记自动设为私有"
            >
              <span className="w-4 shrink-0 text-xs text-center">{priv === 'self' ? '🔓' : '🔒'}</span>
              <span className="truncate">{priv === 'self' ? '取消私密' : '设为私密'}</span>
            </button>
          )}
          <div className="my-1 h-px bg-gray-100" />
          {/* P16.3:有子本不再置灰——删除会级联整棵子树,后果由确认框摊开 */}
          <button
            onClick={handleDelete}
            className="w-full text-left px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2 transition-colors"
          >
            <span className="w-4 shrink-0 text-xs text-center">🗑️</span>
            <span className="truncate">删除笔记本</span>
          </button>
        </div>
        )
      })()}

      {/* P16.1 移动:候选里排除自己与自己的子孙(否则会造出环),服务端还会再判一次 */}
      {moving !== null && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center" onMouseDown={() => setMoving(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-80 max-w-[92vw] p-4" onMouseDown={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">
              移动「{notebooks.find((n) => n.id === moving)?.name}」
            </h3>
            <p className="text-[11px] text-gray-400 mb-2">选一个新的上级；里面的笔记不会动。</p>
            <div className="max-h-72 overflow-y-auto border border-gray-100 rounded-lg divide-y divide-gray-50">
              <button
                onClick={() => { const id = moving; setMoving(null); handleMove(id, null) }}
                className="w-full text-left px-3 py-2 text-sm text-gray-500 hover:bg-gray-50"
              >
                ↥ 移到最外层
              </button>
              {moveTargets.map((t) => (
                <button
                  key={t.nb.id}
                  onClick={() => { const id = moving; setMoving(null); handleMove(id, t.nb.id) }}
                  className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-emerald-50 truncate"
                  style={{ paddingLeft: 12 + Math.min(t.depth, MAX_INDENT_DEPTH) * INDENT_PX }}
                >
                  {inPrivateBranch(notebooks, t.nb.id) ? '🔒' : '📓'} {t.nb.name}
                </button>
              ))}
              {moveTargets.length === 0 && (
                <p className="px-3 py-3 text-xs text-gray-400">没有别的笔记本可以放进去</p>
              )}
            </div>
          </div>
        </div>
      )}

      {delAsk && (
        <ConfirmDialog
          title={delAsk.prompt.title}
          message={delAsk.prompt.message}
          confirmText={delAsk.prompt.confirmText}
          typeToConfirm={delAsk.prompt.typeToConfirm}
          onConfirm={() => { const id = delAsk.id; setDelAsk(null); onDelete(id) }}
          onCancel={() => setDelAsk(null)}
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

      {/* P16.5:确认框摊开的是「确认之后别人看不见了什么」,而不是一个数字 */}
      {lockAsk && (
        <ConfirmDialog
          title={`把「${lockAsk.name}」设为私密笔记本？`}
          message={
            `这一支（含 ${lockAsk.impact.notebooks} 个笔记本）里有 ${lockAsk.impact.articles} 篇笔记会被转为私有。` +
            (lockAsk.impact.published > 0 ? `其中 ${lockAsk.impact.published} 篇已公开，会立即从博客下线。` : '') +
            (lockAsk.impact.shared > 0 ? `另有 ${lockAsk.impact.shared} 个分享链接会立即失效。` : '') +
            '之后写进这一支的笔记也会自动私有。要放行某一篇，去那一篇上单独取消私有。'
          }
          confirmText={lockAsk.impact.published > 0 ? `设为私密并下线 ${lockAsk.impact.published} 篇` : '设为私密'}
          onConfirm={() => { const r = lockAsk.run; setLockAsk(null); r() }}
          onCancel={() => setLockAsk(null)}
        />
      )}

      {/* 取消私密:解释而非警告——已有笔记不解锁,真正变的是「以后新写的不再自动私有」 */}
      {unlockAsk && (
        <ConfirmDialog
          title={`取消「${unlockAsk.name}」的私密？`}
          message={`里面已有的 ${unlockAsk.kept} 篇笔记仍然保持私有，不会自动公开。变的是：之后新写进这一支的笔记不再自动设为私有。要让某几篇重新可公开，去那几篇上单独取消私有。`}
          confirmText="取消私密"
          onConfirm={() => { const id = unlockAsk.id; setUnlockAsk(null); onSetPrivate(id, false) }}
          onCancel={() => setUnlockAsk(null)}
        />
      )}
    </div>
  )
}
