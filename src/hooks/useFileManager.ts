// 文件管理共享数据(P11.6):左栏上移为应用侧栏二级菜单后,
// 侧栏导航(FileManagerNav)与右侧文件列表(FileManager)是两棵独立的组件树,
// 但共用同一份 overview(统计/未引用数/笔记本附件数/文件夹树)与同一套文件夹增删改。
// 放在这里做单一数据源:只拉一次 /api/fm/overview,任一侧改动后两边一起刷新。
//
// 注:当前选中的子视图(view)不在此处——它要与 URL 双向同步,由 Layout 持有(见 src/lib/route.ts 的 fm 参数)。

import { useCallback, useState } from 'react'
import type { FolderNode, FolderRow } from '../lib/fmUtils'

export interface FmOverview {
  stats: { count: number; size: number }
  unref_count: number
  notebooks: { id: number; name: string; color: string; file_count: number }[]
  folders: (FolderRow & { created_at: string })[]
}

/**
 * 文件管理子视图;name 不入 view(改名后从 overview 现取,避免标题过期)。
 *
 * P17.3 改动:
 *  - `folder` 的 id 可为 null = 「我的文件夹」根层。此前根层没有对应视图——
 *    文件夹树整棵挂在侧栏里,没有「站在根上」这个状态。
 *  - `notebook` 从「侧栏里的一棵按笔记本分的树」变成「笔记附件视图 + 一个筛选值」,
 *    id 为 null 表示不筛(看全部被引用的附件)。见 DESIGN §10 P17.3 里
 *    「投影而不是容器」那段论证。
 */
export type FmView =
  | { kind: 'all' }
  | { kind: 'unref' }
  | { kind: 'notebook'; id: number | null }
  | { kind: 'folder'; id: number | null }

/**
 * 移进私密文件夹会失效的公开引用(P14.2)。私密文件对访客一票否决,
 * 所以这个动作会让已发布博客里的图当场变裂图——服务端先回名单,确认了才真移。
 */
export interface PubRefWarn {
  id: number
  name: string
  articles: { id: number; title: string }[]
}

export interface UseFileManager {
  overview: FmOverview | null
  reloadOverview: () => Promise<void>
  /** 文件夹结构变动计数:右侧列表据此重拉文件 */
  tick: number
  notice: string
  flash: (msg: string) => void

  folderInput: { parent: number | null; parentName?: string } | null
  setFolderInput: (v: { parent: number | null; parentName?: string } | null) => void
  folderName: string
  setFolderName: (v: string) => void
  folderRename: FolderRow | null
  setFolderRename: (v: FolderRow | null) => void
  folderRenameVal: string
  setFolderRenameVal: (v: string) => void
  folderDelete: FolderRow | null
  setFolderDelete: (v: FolderRow | null) => void
  folderMove: FolderNode | null
  setFolderMove: (v: FolderNode | null) => void

  submitFolderCreate: () => Promise<void>
  submitFolderRename: () => Promise<void>
  /** 删除当前所在文件夹时,调用方需把视图回落到「全部文件」——返回被删 id 供判断 */
  submitFolderDelete: () => Promise<number | null>
  submitFolderMove: (parentId: number | null) => Promise<void>
  /**
   * 把一批文件移进某个文件夹(P13.3 拖拽落地)。放在这个 hook 里而不是 FileManager 里,
   * 是因为拖起来的是右侧列表的行、落下的是侧栏的目录节点,两个组件只共享这个 hook。
   * 成功后 bump tick,右侧列表据此重拉。
   */
  moveFilesToFolder: (folderId: number | null, ids: number[]) => Promise<void>
  /**
   * 「移进私密文件夹会让这些公开文章的图失效」确认框(P14.2)。
   * 状态放在 hook 里而不是某个组件里,是因为触发它的三条路径分属两棵组件树:
   * 右侧列表的批量移动、侧栏的目录移动、以及从列表拖到侧栏目录。
   * 弹窗本体渲染在 FileManager 里(这三条路径发生时它必然在屏幕上)。
   */
  pubWarn: { files: PubRefWarn[]; onConfirm: () => void } | null
  setPubWarn: (v: { files: PubRefWarn[]; onConfirm: () => void } | null) => void
  /**
   * 正在拖文件(P13.7)。侧栏的「拖到此处移出文件夹」落点据此显示——
   * 它此前是常驻的,于是不拖的时候、切到别的目录之后都还挂在树下面。
   * 和 moveFilesToFolder 同一个理由放在 hook 里:拖起来的行在 FileManager、落点在 FileManagerNav。
   */
  draggingFiles: boolean
  setDraggingFiles: (v: boolean) => void
}

export function useFileManager(token: string): UseFileManager {
  const [overview, setOverview] = useState<FmOverview | null>(null)
  const [tick, setTick] = useState(0)
  const [notice, setNotice] = useState('')

  const [folderInput, setFolderInput] = useState<{ parent: number | null; parentName?: string } | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderRename, setFolderRename] = useState<FolderRow | null>(null)
  const [folderRenameVal, setFolderRenameVal] = useState('')
  const [folderDelete, setFolderDelete] = useState<FolderRow | null>(null)
  const [folderMove, setFolderMove] = useState<FolderNode | null>(null)
  const [draggingFiles, setDraggingFiles] = useState(false)
  const [pubWarn, setPubWarn] = useState<{ files: PubRefWarn[]; onConfirm: () => void } | null>(null)

  const api = useCallback(
    async (path: string, init?: RequestInit): Promise<any> => {
      const res = await fetch(path, {
        ...init,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init?.headers as any) },
      })
      return res.json()
    },
    [token]
  )

  const reloadOverview = useCallback(async () => {
    const j = await api('/api/fm/overview').catch(() => null)
    if (j?.ok) setOverview(j.data)
  }, [api])

  const flash = useCallback((msg: string) => {
    setNotice(msg)
    setTimeout(() => setNotice(''), 3000)
  }, [])

  const moveFilesToFolder = useCallback(async (folderId: number | null, ids: number[]) => {
    if (ids.length === 0) return
    const post = (force: boolean) => api('/api/fm/files/batch', {
      method: 'POST',
      body: JSON.stringify({ op: 'move', ids, folder_id: folderId, force }),
    }).catch(() => null)
    const done = async (d: any) => {
      flash(`已移动 ${d.moved} 个文件` + (d.revoked_shares > 0 ? `,其中 ${d.revoked_shares} 个原分享已取消` : ''))
      setTick((t) => t + 1)
      await reloadOverview()
    }

    const j = await post(false)
    if (!j?.ok) return flash(j?.error || '移动失败')
    // 落点是私密文件夹、而拖的文件正被公开文章引用:先确认再移(P14.2)
    if (j.data?.needs_force) {
      setPubWarn({
        files: j.data.public_refs,
        onConfirm: async () => {
          setPubWarn(null)
          const again = await post(true)
          if (!again?.ok) return flash(again?.error || '移动失败')
          await done(again.data || {})
        },
      })
      return
    }
    await done(j.data || {})
  }, [api, flash, reloadOverview])

  const submitFolderCreate = useCallback(async () => {
    if (!folderInput || !folderName.trim()) return
    const j = await api('/api/fm/folders', { method: 'POST', body: JSON.stringify({ name: folderName.trim(), parent_id: folderInput.parent }) })
    if (!j?.ok) flash(j?.error || '创建失败')
    setFolderInput(null)
    setFolderName('')
    await reloadOverview()
  }, [api, flash, folderInput, folderName, reloadOverview])

  const submitFolderRename = useCallback(async () => {
    if (!folderRename || !folderRenameVal.trim()) return
    const j = await api(`/api/fm/folders/${folderRename.id}`, { method: 'PUT', body: JSON.stringify({ name: folderRenameVal.trim() }) })
    if (!j?.ok) flash(j?.error || '重命名失败')
    setFolderRename(null)
    await reloadOverview()
  }, [api, flash, folderRename, folderRenameVal, reloadOverview])

  const submitFolderDelete = useCallback(async (): Promise<number | null> => {
    if (!folderDelete) return null
    const id = folderDelete.id
    const j = await api(`/api/fm/folders/${id}`, { method: 'DELETE' })
    setFolderDelete(null)
    if (!j?.ok) {
      flash(j?.error || '删除失败')
      await reloadOverview()
      return null
    }
    await reloadOverview()
    return id
  }, [api, flash, folderDelete, reloadOverview])

  const submitFolderMove = useCallback(async (parentId: number | null) => {
    if (!folderMove) return
    const id = folderMove.id
    const post = (force: boolean) => api(`/api/fm/folders/${id}`, {
      method: 'PUT', body: JSON.stringify({ parent_id: parentId, force }),
    })
    const done = async (d: any) => {
      if (d?.revoked_shares > 0) flash(`已移入私密文件夹,取消了 ${d.revoked_shares} 个文件的分享`)
      await reloadOverview()
      setTick((t) => t + 1) // 文件可能随目录换位,右侧列表重拉
    }

    const j = await post(false)
    setFolderMove(null)
    if (!j?.ok) { flash(j?.error || '移动失败'); return }
    // 整个目录搬进私密子树,里面有公开文章在用的图:先确认(P14.2)
    if (j.data?.needs_force) {
      setPubWarn({
        files: j.data.public_refs,
        onConfirm: async () => {
          setPubWarn(null)
          const again = await post(true)
          if (!again?.ok) return flash(again?.error || '移动失败')
          await done(again.data)
        },
      })
      return
    }
    await done(j.data)
  }, [api, flash, folderMove, reloadOverview])

  return {
    overview, reloadOverview, tick, notice, flash,
    folderInput, setFolderInput, folderName, setFolderName,
    folderRename, setFolderRename, folderRenameVal, setFolderRenameVal,
    folderDelete, setFolderDelete, folderMove, setFolderMove,
    submitFolderCreate, submitFolderRename, submitFolderDelete, submitFolderMove,
    moveFilesToFolder,
    pubWarn, setPubWarn,
    draggingFiles, setDraggingFiles,
  }
}
