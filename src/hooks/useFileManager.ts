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

/** 文件管理子视图;name 不入 view(改名后从 overview 现取,避免标题过期) */
export type FmView =
  | { kind: 'all' }
  | { kind: 'unref' }
  | { kind: 'notebook'; id: number }
  | { kind: 'folder'; id: number }

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
    const j = await api(`/api/fm/folders/${folderMove.id}`, { method: 'PUT', body: JSON.stringify({ parent_id: parentId }) })
    if (!j?.ok) flash(j?.error || '移动失败')
    else if (j.data?.revoked_shares > 0) flash(`已移入私密文件夹,取消了 ${j.data.revoked_shares} 个文件的分享`)
    setFolderMove(null)
    await reloadOverview()
    setTick((t) => t + 1) // 文件可能随目录换位,右侧列表重拉
  }, [api, flash, folderMove, reloadOverview])

  return {
    overview, reloadOverview, tick, notice, flash,
    folderInput, setFolderInput, folderName, setFolderName,
    folderRename, setFolderRename, folderRenameVal, setFolderRenameVal,
    folderDelete, setFolderDelete, folderMove, setFolderMove,
    submitFolderCreate, submitFolderRename, submitFolderDelete, submitFolderMove,
  }
}
