import { useState, useEffect } from 'react'
import { useApi } from '../hooks/useApi'
import { CHANNEL_META, CHANNEL_TYPES, isSecretField, isMaskedValue, type NotifyChannel, type ChannelType } from '../lib/notifyChannels'
import { PRERENDER_KEY, parsePrerenderMode, type PrerenderMode } from '../lib/blogSeo'
import { CUSTOM_JS_KEY, MAX_CUSTOM_JS, describeCustomScripts } from '../lib/blogScripts'
import { FM_CHECKBOX_KEY, parseCheckboxMode, type CheckboxMode } from '../lib/fmUtils'
import {
  BACKUP_INTERVALS, DEFAULT_INTERVAL, DEFAULT_KEEP, MAX_KEEP,
  parseInterval, parseKeep, retentionSpan, type BackupInterval,
} from '../lib/backupPlan'
import { formatBytes } from '../lib/format'
import type { Settings, ModelInfo } from '../types'

const MODELS: ModelInfo[] = [
  { id: '@cf/meta/llama-3.1-8b-instruct', label: 'Llama 3.1 8B', description: '轻量快速，适合简单问答', type: '通用', cost: '~15 neurons' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'Llama 3.3 70B', description: '大模型，综合能力强', type: '通用', cost: '~88 neurons' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'DeepSeek R1 32B', description: '推理能力强，适合复杂分析', type: '推理', cost: '~178 neurons' },
  { id: '@cf/qwen/qwq-32b', label: 'QwQ 32B', description: '推理型，中文表现优秀', type: '推理', cost: '~87 neurons' },
]

/**
 * 分类导航(P17)。此前所有设置项堆在一个 max-w-lg 的窗口里往下滚,到 P16.9 已经
 * 长到十几屏——找一项要滚半天,而各节之间只靠一行小标题分隔,看着是一整片。
 *
 * 没有「系统」这一类:系统日志是独立面板(顶栏那个图标),在这里放一个「请从顶栏打开」
 * 的空分类,比不放还差。
 */
export type SettingsCategory = 'ai' | 'blog' | 'comments' | 'files' | 'notify' | 'backup' | 'account'

const CATEGORIES: { id: SettingsCategory; label: string; hint: string; icon: string }[] = [
  { id: 'ai', label: 'AI 对话', hint: '模型与 API Key', icon: '🤖' },
  { id: 'blog', label: '博客', hint: '预渲染、自定义脚本', icon: '📝' },
  { id: 'comments', label: '评论', hint: '开关与审核', icon: '💬' },
  { id: 'files', label: '文件', hint: '列表多选方式', icon: '📁' },
  { id: 'notify', label: '通知', hint: '提醒推送渠道', icon: '🔔' },
  { id: 'backup', label: '备份', hint: '导出、导入、自动备份', icon: '💾' },
  { id: 'account', label: '账号', hint: '修改密码', icon: '👤' },
]

interface Props {
  token: string
  onClose: () => void
  /** 打开时直接落在某一分类(文件管理右上角的齿轮传 'files') */
  focus?: SettingsCategory | null
  /** 改密码后换成新签发的 token(P16.9) */
  onTokenChange?: (token: string) => void
}

/** GET /api/backups 的返回:列表与配置一次拉完,不为一个开关多打一趟请求 */
interface BackupInfo {
  available: boolean
  interval: BackupInterval
  keep: number
  span: string
  last_at: string
  last_size: number
  last_error: string
  next_at: string
  files: { name: string; size: number; created_at: string }[]
}

export default function SettingsPanel({ token, onClose, focus, onTokenChange }: Props) {
  const api = useApi(token)
  // 窄屏是「分类列表 → 某一类」的返回栈,所以初值可以是 null;桌面两栏同屏,
  // null 会让右边空着,所以直接落在第一类上
  const [cat, setCat] = useState<SettingsCategory | null>(
    () => focus ?? (typeof window !== 'undefined' && window.innerWidth >= 640 ? 'ai' : null))
  const [selected, setSelected] = useState('')
  const [jinaKey, setJinaKey] = useState('')
  const [showJinaKey, setShowJinaKey] = useState(false)
  // P10.3 通知渠道(提醒推送)
  const [channels, setChannels] = useState<NotifyChannel[]>([])
  // 已保存渠道快照(归一化 JSON):测试走实时表单、cron 走已存配置,用它检测「测了但没保存」
  const [savedChannels, setSavedChannels] = useState('[]')
  // 正在改写的凭据字段 → 它原来的掩码值(用于「取消」还原);键为 `渠道id:字段名`
  const [editSecret, setEditSecret] = useState<Record<string, string>>({})
  // P11.2 评论设置
  const [commentsEnabled, setCommentsEnabled] = useState(true)
  const [commentsAutoApprove, setCommentsAutoApprove] = useState(false)
  // P12.6 博客详情页预渲染档位
  const [prerender, setPrerender] = useState<PrerenderMode>('full')
  // P12.12 博客自定义脚本
  const [customJs, setCustomJs] = useState('')
  const [testing, setTesting] = useState<string | null>(null)
  const [testMsg, setTestMsg] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState('')
  // 导出时是否带上文章历史版本(P12.11)
  const [withVersions, setWithVersions] = useState(false)
  // P14.2 自动备份到 R2
  const [backupInterval, setBackupInterval] = useState<BackupInterval>(DEFAULT_INTERVAL)
  const [backupKeep, setBackupKeep] = useState(DEFAULT_KEEP)
  const [backupInfo, setBackupInfo] = useState<BackupInfo | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const [backupMsg, setBackupMsg] = useState('')
  const [error, setError] = useState('')

  // 文件管理的列表复选框(P13.7):存 localStorage(每台设备各自的显示偏好,见 fmUtils 里的论证),
  // 不进 /api/settings ——否则每次打开文件管理都要多打一次请求。
  const [fmCheckbox, setFmCheckbox] = useState<CheckboxMode>(() =>
    parseCheckboxMode(typeof localStorage !== 'undefined' ? localStorage.getItem(FM_CHECKBOX_KEY) : null))

  const applyFmCheckbox = (m: CheckboxMode) => {
    setFmCheckbox(m)
    localStorage.setItem(FM_CHECKBOX_KEY, m)
  }

  // Esc:窄屏且已进到某一分类时先退回分类列表,再按才关面板。
  // 桌面下 cat 恒不为 null(默认落在第一类),所以这个分支只在窄屏生效——
  // 用 window.innerWidth 判断而不是加一个状态,是因为它只在按键那一刻读一次
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (cat !== null && window.innerWidth < 640) setCat(null)
      else onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, cat])

  useEffect(() => {
    (async () => {
      const [res, bk] = await Promise.all([
        api.get<Settings>('/settings'),
        api.get<BackupInfo>('/backups'),
      ])
      if (res.ok && res.data) {
        setSelected(res.data.llm_model)
        if (res.data.jina_api_key) setJinaKey(res.data.jina_api_key)
        const nc = (res.data as any).notify_channels
        if (nc) { try { const parsed = JSON.parse(nc); setChannels(parsed); setSavedChannels(JSON.stringify(parsed)) } catch { /* 坏值忽略 */ } }
        setCommentsEnabled((res.data as any).comments_enabled !== '0')
        setCommentsAutoApprove((res.data as any).comments_auto_approve === '1')
        setPrerender(parsePrerenderMode((res.data as any)[PRERENDER_KEY]))
        setCustomJs(((res.data as any)[CUSTOM_JS_KEY] as string) || '')
      } else {
        setError(res.error || '加载失败')
      }
      if (bk.ok && bk.data) {
        setBackupInfo(bk.data)
        setBackupInterval(parseInterval(bk.data.interval))
        setBackupKeep(parseKeep(String(bk.data.keep)))
      }
      setLoading(false)
    })()
  }, [api])

  const handleSave = async () => {
    setSaving(true)
    setError('')
    const channelsJson = JSON.stringify(channels)
    const res = await api.put<Settings>('/settings', {
      llm_model: selected,
      ...(jinaKey ? { jina_api_key: jinaKey } : {}),
      notify_channels: channelsJson,
      comments_enabled: commentsEnabled ? '1' : '0',
      comments_auto_approve: commentsAutoApprove ? '1' : '0',
      [PRERENDER_KEY]: prerender,
      [CUSTOM_JS_KEY]: customJs,
      backup_interval: backupInterval,
      backup_keep: String(backupKeep),
      site_url: window.location.origin,
    })
    if (res.ok) {
      setSavedChannels(channelsJson)
      onClose()
    } else {
      setError(res.error || '保存失败')
    }
    setSaving(false)
  }

  // P16.9 改密码。改完会吊销所有旧 token(包括自己手里这张),接口直接返回一张新的
  const [pwOld, setPwOld] = useState('')
  const [pwNew, setPwNew] = useState('')
  const [pwNew2, setPwNew2] = useState('')
  const [pwBusy, setPwBusy] = useState(false)
  const [pwMsg, setPwMsg] = useState('')
  const [pwErr, setPwErr] = useState('')

  const changePassword = async () => {
    setPwErr('')
    setPwMsg('')
    // 两次确认在前端拦:这是打错字的问题,不值得占一次请求
    if (pwNew !== pwNew2) { setPwErr('两次输入的新密码不一致'); return }
    if (pwNew.length < 6) { setPwErr('新密码至少 6 个字符'); return }
    setPwBusy(true)
    try {
      const res = await api.post<{ token: string }>('/auth/password', {
        old_password: pwOld, new_password: pwNew,
      })
      if (!res.ok || !res.data) { setPwErr(res.error || '修改失败'); return }
      // 必须换掉本地 token,否则接下来每个请求都是 401——旧的已经被吊销了
      onTokenChange?.(res.data.token)
      setPwOld(''); setPwNew(''); setPwNew2('')
      setPwMsg('密码已修改，其他设备上的登录已全部失效')
    } finally {
      setPwBusy(false)
    }
  }

  // 分批触发向量索引直到没有剩余;剩余不再减少说明持续失败,停止。返回失败信息列表。
  // 导入后的首次建立与手动重试共用同一逻辑。
  const runReindexLoop = async (onProgress: (remaining: number) => void): Promise<string[]> => {
    let lastRemaining = Infinity
    const errors: string[] = []
    while (true) {
      const r = await api.post<{ processed: number; remaining: number; errors: string[] }>('/reindex', {})
      if (!r.ok || !r.data) break
      errors.push(...r.data.errors)
      if (r.data.remaining === 0 || r.data.remaining >= lastRemaining) break
      lastRemaining = r.data.remaining
      onProgress(r.data.remaining)
    }
    return errors
  }

  const handleReindex = async () => {
    setImporting(true)
    setImportMsg('正在检查并建立向量索引...')
    setError('')
    try {
      const errors = await runReindexLoop((n) => setImportMsg(`正在建立向量索引... 剩余 ${n} 篇`))
      setImportMsg(errors.length > 0 ? `索引重建结束，${errors.length} 篇失败：${errors[0]}` : '向量索引已全部建立')
    } catch (e: any) {
      setError(e.message)
      setImportMsg('')
    } finally {
      setImporting(false)
    }
  }

  // 导入备份:JSON(仅数据)或 ZIP(数据 + 附件按原 key 恢复)→ 合并导入 → 分批补建向量
  const handleImportFile = async (file: File) => {
    setImporting(true)
    setImportMsg('')
    setError('')
    try {
      let data: any
      let zip: any = null
      if (/\.zip$/i.test(file.name)) {
        const { default: JSZip } = await import('jszip')
        zip = await JSZip.loadAsync(file)
        const ej = zip.file('export.json')
        if (!ej) throw new Error('ZIP 包中缺少 export.json，不是 CFNote 完整备份文件')
        data = JSON.parse(await ej.async('string'))
      } else {
        try { data = JSON.parse(await file.text()) } catch { throw new Error('文件不是有效的 JSON') }
      }

      setImportMsg('正在导入数据...')
      const res = await api.post<{
        notebooks_created: number; articles_imported: number; articles_skipped: number
        comments_imported?: number; settings_restored?: number
      }>('/import', data)
      if (!res.ok || !res.data) throw new Error(res.error || '导入失败')
      const { notebooks_created, articles_imported, articles_skipped, comments_imported = 0, settings_restored = 0 } = res.data

      // 恢复附件(ZIP):按原 key 写回 R2,笔记中的链接保持有效
      let restored = 0
      let restoreFailed = 0
      if (zip) {
        const entries: any[] = []
        zip.forEach((path: string, f: any) => { if (path.startsWith('files/') && !f.dir) entries.push(f) })
        for (const f of entries) {
          const key = f.name.slice('files/'.length)
          setImportMsg(`正在恢复附件 ${restored + restoreFailed + 1}/${entries.length}...`)
          try {
            const r = await fetch(`/api/files/${encodeKey(key)}`, {
              method: 'PUT',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': guessMime(key) },
              body: await f.async('arraybuffer'),
            })
            const j: any = await r.json().catch(() => null)
            if (j?.ok) restored++
            else restoreFailed++
          } catch { restoreFailed++ }
        }
      }

      // 导入成功后由前端分批触发向量索引(每批一次独立请求,直到没有剩余)
      const vecErrors = articles_imported > 0
        ? await runReindexLoop((n) => setImportMsg(`正在建立向量索引... 剩余 ${n} 篇`))
        : []

      setImportMsg(
        `导入完成：新建笔记本 ${notebooks_created} 个，导入文章 ${articles_imported} 篇` +
        (articles_skipped > 0 ? `，跳过重复 ${articles_skipped} 篇` : '') +
        (comments_imported > 0 ? `，恢复评论 ${comments_imported} 条` : '') +
        (settings_restored > 0 ? `，恢复博客配置 ${settings_restored} 项` : '') +
        (zip ? `，恢复附件 ${restored} 个` + (restoreFailed > 0 ? `（${restoreFailed} 个失败）` : '') : '') +
        (vecErrors.length > 0 ? `；${vecErrors.length} 篇索引失败，可点击下方按钮重试` : '')
      )
    } catch (e: any) {
      setError(e.message)
      setImportMsg('')
    } finally {
      setImporting(false)
    }
  }

  // ---- 附件相关工具 ----
  const extractFileKeys = (contents: string[]): string[] => {
    const keys = new Set<string>()
    const re = /\/api\/files\/(u\d+\/[A-Za-z0-9]+\/[^\s)"'<>\]]+)/g
    for (const ct of contents) {
      let m: RegExpExecArray | null
      re.lastIndex = 0
      while ((m = re.exec(ct || ''))) {
        try { keys.add(decodeURIComponent(m[1])) } catch { keys.add(m[1]) }
      }
    }
    return [...keys]
  }

  const guessMime = (name: string): string => {
    const ext = (name.split('.').pop() || '').toLowerCase()
    const map: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', xmind: 'application/vnd.xmind.workbook',
      pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain',
    }
    return map[ext] || 'application/octet-stream'
  }

  const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')

  const jsInfo = describeCustomScripts(customJs)

  // ---- P10.3 通知渠道管理 ----
  const addChannel = (type: ChannelType) =>
    setChannels((cs) => [...cs, { id: crypto.randomUUID(), type, enabled: true, config: {} }])
  const updateChannel = (id: string, patch: Partial<NotifyChannel>) =>
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  const updateConfig = (id: string, key: string, value: string) =>
    setChannels((cs) => cs.map((c) => (c.id === id ? { ...c, config: { ...c.config, [key]: value } } : c)))
  const removeChannel = (id: string) => {
    setChannels((cs) => cs.filter((c) => c.id !== id))
    setTestMsg((m) => { const n = { ...m }; delete n[id]; return n })
  }
  // 凭据字段(P12.10)默认只显示「已设置 ****后四位」。点「修改」才清空成可输入状态,
  // 并把原来的掩码记下来供「取消」还原——否则误点一下再保存就把凭据清了。
  const secretId = (id: string, key: string) => `${id}:${key}`
  const beginEditSecret = (id: string, key: string, masked: string) => {
    setEditSecret((m) => ({ ...m, [secretId(id, key)]: masked }))
    updateConfig(id, key, '')
  }
  const cancelEditSecret = (id: string, key: string) => {
    const masked = editSecret[secretId(id, key)]
    if (masked !== undefined) updateConfig(id, key, masked)
    setEditSecret((m) => { const n = { ...m }; delete n[secretId(id, key)]; return n })
  }
  const testChannel = async (ch: NotifyChannel) => {
    setTesting(ch.id)
    setTestMsg((m) => ({ ...m, [ch.id]: '' }))
    const r = await api.post<{ sent: boolean }>('/notify/test', { channel: ch })
    // 测试走的是面板里的实时配置;若尚未保存,cron 到期推送读的是旧的已存配置,必须提示
    const unsaved = JSON.stringify(channels) !== savedChannels
    const okMsg = unsaved
      ? '✅ 已发送,请检查是否收到(注意:当前配置尚未保存,到期推送不会用它,请点右下角「保存」)'
      : '✅ 已发送,请检查是否收到'
    setTestMsg((m) => ({ ...m, [ch.id]: r.ok ? okMsg : `❌ ${r.error || '发送失败'}` }))
    setTesting(null)
  }

  // 版本历史体积可能比正文本身还大(每篇几十版),默认不进备份,要就勾上
  const exportUrl = () => (withVersions ? '/api/export?versions=1' : '/api/export')

  // 完整备份:导出 JSON + 全部附件打包为 ZIP
  const handleExportZip = async () => {
    setExporting(true)
    setError('')
    setImportMsg('')
    try {
      const res = await fetch(exportUrl(), { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const j = await res.json().catch(() => null) as any
        throw new Error(j?.error || `导出失败 (${res.status})`)
      }
      const data = await res.json() as any
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      zip.file('export.json', JSON.stringify(data, null, 2))

      const keys = extractFileKeys((data.articles || []).map((a: any) => a.content || ''))
      let packed = 0
      let missing = 0
      for (const key of keys) {
        setImportMsg(`正在打包附件 ${packed + missing + 1}/${keys.length}...`)
        const fr = await fetch(`/api/files/${encodeKey(key)}`)
        if (!fr.ok) { missing++; continue }
        zip.file(`files/${key}`, await fr.arrayBuffer())
        packed++
      }

      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cfnote-backup-${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
      setImportMsg(`完整备份已导出：${packed} 个附件` + (missing > 0 ? `（${missing} 个引用已失效，跳过）` : ''))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  const handleExport = async () => {
    setExporting(true)
    setError('')
    try {
      const res = await fetch(exportUrl(), { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const j = await res.json().catch(() => null) as any
        throw new Error(j?.error || `导出失败 (${res.status})`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `cfnote-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setExporting(false)
    }
  }

  // ---- 自动备份到 R2(P14.2)----

  const reloadBackups = async () => {
    const r = await api.get<BackupInfo>('/backups')
    if (r.ok && r.data) setBackupInfo(r.data)
  }

  // 有这个按钮才不用等一整个周期,才知道这功能到底能不能跑
  const handleBackupNow = async () => {
    setBackupBusy(true)
    setBackupMsg('')
    const r = await api.post<{ files: number; bytes: number; pruned: number }>('/backups/run', {})
    if (r.ok && r.data) {
      setBackupMsg(`已备份 ${formatBytes(r.data.bytes)}` + (r.data.pruned > 0 ? `，清掉 ${r.data.pruned} 份旧的` : ''))
      await reloadBackups()
    } else {
      setBackupMsg(`❌ ${r.error || '备份失败'}`)
    }
    setBackupBusy(false)
  }

  const handleBackupDownload = async (name: string) => {
    try {
      const res = await fetch(`/api/backups/${name}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`下载失败 (${res.status})`)
      const url = URL.createObjectURL(await res.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setBackupMsg(`❌ ${e.message}`)
    }
  }

  const handleBackupDelete = async (name: string) => {
    const r = await api.del(`/backups/${name}`)
    if (!r.ok) setBackupMsg(`❌ ${r.error || '删除失败'}`)
    await reloadBackups()
  }

  // 恢复 = 下载那一份再走既有的导入流程,服务端不另写一套恢复逻辑
  const handleBackupRestore = async (name: string) => {
    try {
      const res = await fetch(`/api/backups/${name}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) throw new Error(`读取备份失败 (${res.status})`)
      await handleImportFile(new File([await res.blob()], name, { type: 'application/json' }))
    } catch (e: any) {
      setBackupMsg(`❌ ${e.message}`)
    }
  }

  const curCat = CATEGORIES.find((c) => c.id === cat)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[6vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/40" />
      <div
        className="relative bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col overflow-hidden mx-3"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-4 border-b border-gray-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            {/* 窄屏:从某一类退回分类列表。桌面两栏同屏,不需要 */}
            {cat !== null && (
              <button
                onClick={() => setCat(null)}
                className="sm:hidden p-1 -ml-1 rounded-lg hover:bg-gray-100 text-gray-500 shrink-0"
                aria-label="返回设置分类"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}
            <svg className={`w-5 h-5 text-emerald-500 shrink-0 ${cat !== null ? 'max-sm:hidden' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {/* 窄屏进到某一类后标题换成那一类的名字:此时分类列表已经不在屏幕上, */}
            {/* 只写「设置」的话没有任何东西告诉你现在在哪一类 */}
            <span className="font-semibold text-gray-900 truncate">
              设置<span className="sm:hidden">{curCat ? ` · ${curCat.label}` : ''}</span>
            </span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 shrink-0">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 左导航 + 右内容。窄屏一次只显示一层(cat === null 时是分类列表) */}
        <div className="flex-1 flex min-h-0">
          <nav className={`w-44 shrink-0 border-r border-gray-100 bg-gray-50/60 overflow-y-auto p-2 ${
            cat === null ? 'max-sm:w-full max-sm:border-r-0' : 'max-sm:hidden'
          }`}>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCat(c.id)}
                className={`w-full text-left rounded-lg px-2.5 py-2 mb-0.5 transition-colors ${
                  cat === c.id
                    ? 'bg-emerald-50 text-emerald-700 max-sm:bg-transparent max-sm:text-gray-800'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm shrink-0">{c.icon}</span>
                  <span className="text-sm font-medium truncate">{c.label}</span>
                  <svg className="w-4 h-4 ml-auto text-gray-300 shrink-0 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                </span>
                <span className={`block text-[11px] truncate ml-6 ${cat === c.id ? 'text-emerald-600/70 max-sm:text-gray-400' : 'text-gray-400'}`}>
                  {c.hint}
                </span>
              </button>
            ))}
          </nav>

          {/* Content */}
          <div className={`flex-1 overflow-y-auto p-4 space-y-4 min-w-0 ${cat === null ? 'max-sm:hidden' : ''}`}>
          {loading && (
            <div className="text-center py-12">
              <div className="inline-block w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 mt-2">加载设置...</p>
            </div>
          )}

          {error && (
            <div className="text-sm text-red-500 bg-red-50 rounded-lg px-3 py-2">{error}</div>
          )}

          {!loading && cat === 'ai' && (
            <>
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">AI 模型</h3>
                <div className="space-y-2">
                  {MODELS.map((model) => {
                    const isSelected = selected === model.id
                    return (
                      <button
                        key={model.id}
                        onClick={() => setSelected(model.id)}
                        className={`w-full text-left rounded-xl border-2 p-3 transition-all ${
                          isSelected
                            ? 'border-emerald-500 bg-emerald-50'
                            : 'border-gray-200 hover:border-gray-300 bg-white'
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center ${
                              isSelected ? 'border-emerald-500' : 'border-gray-300'
                            }`}>
                              {isSelected && <div className="w-2 h-2 rounded-full bg-emerald-500" />}
                            </div>
                            <span className={`font-medium text-sm ${isSelected ? 'text-emerald-700' : 'text-gray-900'}`}>
                              {model.label}
                            </span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                              model.type === '推理'
                                ? 'bg-violet-100 text-violet-600'
                                : 'bg-blue-100 text-blue-600'
                            }`}>
                              {model.type}
                            </span>
                          </div>
                          <span className="text-xs text-gray-400">{model.cost}</span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1 ml-6">{model.description}</p>
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* API Keys */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">API Keys</h3>
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-medium text-gray-700 mb-1 block">Jina API Key</label>
                    <div className="relative">
                      <input
                        type={showJinaKey ? 'text' : 'password'}
                        value={jinaKey}
                        onChange={(e) => setJinaKey(e.target.value)}
                        placeholder="jina_..."
                        className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 pr-10 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 font-mono"
                      />
                      <button
                        type="button"
                        onClick={() => setShowJinaKey(!showJinaKey)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                      >
                        {showJinaKey ? (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        )}
                      </button>
                    </div>
                    <p className="text-[11px] text-gray-400 mt-1">
                      用于联网搜索和 URL 导入。从 <a href="https://jina.ai" target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline">jina.ai</a> 免费获取。不配置也可使用，但可能受限流影响。
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}

          {!loading && cat === 'notify' && (
            <>
              {/* 通知渠道 / 提醒推送(P10.3) */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">通知渠道 / 提醒推送</h3>
                <p className="text-[11px] text-gray-400 mb-3">
                  给笔记设的提醒到期后,除应用内铃铛外还会推送到下列已启用的渠道(系统每 5 分钟检查一次)。
                </p>
                <div className="space-y-3">
                  {channels.map((ch) => {
                    const meta = CHANNEL_META[ch.type]
                    return (
                      <div key={ch.id} className="border border-gray-200 rounded-xl p-3">
                        <div className="flex items-center justify-between mb-2">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={ch.enabled}
                              onChange={(e) => updateChannel(ch.id, { enabled: e.target.checked })}
                              className="accent-emerald-500"
                            />
                            <span className="text-sm font-medium text-gray-800">{meta.label}</span>
                            {!ch.enabled && <span className="text-[10px] text-gray-400">已停用</span>}
                          </label>
                          <button onClick={() => removeChannel(ch.id)} className="text-xs text-gray-400 hover:text-red-500">删除</button>
                        </div>
                        {meta.fields.map((f) => {
                          const val = ch.config[f.key] || ''
                          const editing = editSecret[secretId(ch.id, f.key)] !== undefined
                          // 已保存的凭据只显示「已设置」,不回显——它同时是 GET /api/settings 的返回值,
                          // 而企业微信/钉钉的 Webhook 地址本身就是能往群里发消息的凭据。
                          if (isSecretField(ch.type, f.key) && isMaskedValue(val) && !editing) {
                            return (
                              <div key={f.key} className="flex items-center gap-2 text-xs mb-1.5 px-2.5 py-1.5 border border-gray-200 rounded-lg bg-gray-50">
                                <span className="text-gray-500 shrink-0">{f.label}</span>
                                <span className="font-mono text-gray-400 flex-1 min-w-0 truncate">已设置 · {val}</span>
                                <button onClick={() => beginEditSecret(ch.id, f.key, val)} className="text-emerald-600 hover:underline shrink-0">修改</button>
                              </div>
                            )
                          }
                          return (
                            <div key={f.key} className="flex items-center gap-2 mb-1.5">
                              <input
                                value={val}
                                onChange={(e) => updateConfig(ch.id, f.key, e.target.value)}
                                placeholder={f.placeholder || f.label + (f.optional ? '(可选)' : '')}
                                className="flex-1 min-w-0 text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400 font-mono"
                              />
                              {editing && (
                                <button onClick={() => cancelEditSecret(ch.id, f.key)} className="text-xs text-gray-400 hover:text-gray-600 shrink-0">取消</button>
                              )}
                            </div>
                          )
                        })}
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-[11px] text-gray-400 flex-1">{meta.help}</p>
                          <button
                            onClick={() => testChannel(ch)}
                            disabled={testing === ch.id}
                            className="text-xs text-emerald-600 hover:underline shrink-0 disabled:opacity-50"
                          >
                            {testing === ch.id ? '发送中...' : '测试'}
                          </button>
                        </div>
                        {testMsg[ch.id] && <p className="text-[11px] mt-1 text-gray-600">{testMsg[ch.id]}</p>}
                      </div>
                    )
                  })}
                </div>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {CHANNEL_TYPES.map((t) => (
                    <button
                      key={t}
                      onClick={() => addChannel(t)}
                      className="text-xs px-2 py-1 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-emerald-400 hover:text-emerald-600 transition-colors"
                    >
                      + {CHANNEL_META[t].label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-2">配置改动需点右下角「保存」后生效;推送消息含笔记标题与打开链接。已保存的 Token / 密钥 / Webhook 地址只显示后四位,点「修改」可换成新值。</p>
                {JSON.stringify(channels) !== savedChannels && (
                  <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mt-2">
                    ⚠️ 通知渠道有未保存的修改。「测试」用的是当前填写的配置,但到期推送用的是<b>已保存</b>的配置——请点右下角「保存」后才会真正生效。
                  </p>
                )}
              </div>
            </>
          )}

          {!loading && cat === 'files' && (
            <>
              {/* 文件管理(P13.7) */}
              <div className="rounded-xl">
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">文件管理</h3>
                <p className="text-[11px] text-gray-400 mb-2">
                  文件列表默认按 Windows 资源管理器的方式多选:单击选中、Ctrl/⌘ 点选、Shift 连选、Ctrl/⌘+A 全选、双击打开。
                  触屏没有这些修饰键,所以默认会自动显示复选框。
                </p>
                {([
                  { v: 'auto', label: '自动(推荐)', hint: '触屏设备显示复选框,鼠标设备不显示' },
                  { v: 'on', label: '总是显示', hint: '桌面也显示复选框' },
                  { v: 'off', label: '从不显示', hint: '触屏上将无法多选' },
                ] as const).map((o) => (
                  <label key={o.v} className="flex items-start gap-2 cursor-pointer py-1">
                    <input
                      type="radio"
                      name="fm-checkbox"
                      checked={fmCheckbox === o.v}
                      onChange={() => applyFmCheckbox(o.v)}
                      className="accent-emerald-500 mt-0.5"
                    />
                    <span>
                      <span className="text-sm text-gray-800">{o.label}</span>
                      <span className="block text-[11px] text-gray-400">{o.hint}</span>
                    </span>
                  </label>
                ))}
                <p className="text-[11px] text-gray-400 mt-1">该选项只影响这台设备,改完立即生效(不用点保存)。</p>
              </div>
            </>
          )}

          {!loading && cat === 'comments' && (
            <>
              {/* 评论(P11.2) */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">评论</h3>
                <p className="text-[11px] text-gray-400 mb-2">公开博客文章底部的访客评论。关闭后访客看不到评论区、也无法提交。</p>
                <label className="flex items-center gap-2 cursor-pointer py-1">
                  <input type="checkbox" checked={commentsEnabled} onChange={(e) => setCommentsEnabled(e.target.checked)} className="accent-emerald-500" />
                  <span className="text-sm text-gray-800">开启评论</span>
                </label>
                <label className={`flex items-center gap-2 cursor-pointer py-1 ${commentsEnabled ? '' : 'opacity-40 pointer-events-none'}`}>
                  <input type="checkbox" checked={commentsAutoApprove} onChange={(e) => setCommentsAutoApprove(e.target.checked)} className="accent-emerald-500" />
                  <span className="text-sm text-gray-800">免审核(提交后直接显示)</span>
                </label>
                <p className="text-[11px] text-gray-400 mt-1">默认需审核:新评论进入待审核队列,在「博客管理 → 评论」通过后才公开显示。</p>
              </div>
            </>
          )}

          {!loading && cat === 'blog' && (
            <>
              {/* 博客预渲染(P12.6) */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">博客详情页预渲染</h3>
                <p className="text-[11px] text-gray-400 mb-2">
                  微信/微博/Twitter 的链接预览抓取器与百度蜘蛛都不执行 JS,只有服务端产出的 HTML 它们才看得见。
                </p>
                <div className="space-y-1">
                  {([
                    ['full', '完整预渲染(推荐)', '标题/摘要/配图 + 正文都进 HTML,前端不再拉接口 —— 每次访问 1 次 Worker 请求'],
                    ['meta', '仅 meta', '只注入标题/摘要/配图,正文仍由前端拉 —— 2 次请求。预渲染出问题时的中间落点'],
                    ['off', '关闭', '原样发静态外壳 —— 2 次请求,且分享卡片与百度收录都会失效'],
                  ] as const).map(([v, label, desc]) => (
                    <label key={v} className="flex items-start gap-2 cursor-pointer py-1">
                      <input
                        type="radio"
                        name="cfnote-prerender"
                        checked={prerender === v}
                        onChange={() => setPrerender(v)}
                        className="accent-emerald-500 mt-0.5"
                      />
                      <span>
                        <span className="text-sm text-gray-800">{label}</span>
                        <span className="block text-[11px] text-gray-400">{desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-gray-400 mt-1">
                  这三档都会经过 Worker(由 wrangler.toml 的 run_worker_first 决定,运行时改不了),所以「关闭」并不会回到最省的状态——
                  它是出问题时不用重新部署就能恢复的开关,不是省配额的开关。改动最多 1 分钟内在边缘缓存生效。
                </p>
              </div>

              {/* 博客自定义脚本(P12.12) */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">博客自定义脚本</h3>
                <p className="text-[11px] text-gray-400 mb-2">
                  统计代码、客服挂件之类。直接粘服务商给的 <code>&lt;script src=…&gt;</code> 片段即可，也可以写纯 JS。
                </p>
                <textarea
                  value={customJs}
                  onChange={(e) => setCustomJs(e.target.value.slice(0, MAX_CUSTOM_JS))}
                  rows={6}
                  spellCheck={false}
                  placeholder={'<script async src="https://hm.baidu.com/hm.js?xxxxxx"></script>'}
                  className="w-full text-xs font-mono border border-gray-200 rounded-lg px-2.5 py-2 outline-none focus:border-emerald-400 focus:ring-1 focus:ring-emerald-400"
                />
                <div className="flex items-center justify-between mt-1">
                  <span className="text-[11px] text-gray-400">
                    {jsInfo.external + jsInfo.inline === 0
                      ? '未配置'
                      : `将注入 ${jsInfo.external} 个外链脚本、${jsInfo.inline} 段内联代码`}
                  </span>
                  <span className="text-[11px] text-gray-400 tabular-nums">{customJs.length} / {MAX_CUSTOM_JS}</span>
                </div>
                <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mt-2 leading-relaxed">
                  ⚠️ 这段代码与管理端、<code>/api/*</code> 在同一个源上，能读到你的登录凭据。危险的不是你自己写的那几行，
                  是从别处粘来的第三方脚本——它被投毒时你的整个知识库都在它手里。只粘信得过来源的代码。
                </p>
                <p className="text-[11px] text-gray-400 mt-1.5 leading-relaxed">
                  在博客列表页与详情页都会执行，在 React 挂载后注入一次（要改首屏样式请用「博客管理 → 页面布局 → 主题外观」的额外 CSS，脚本会晚一步）。
                  这四种情况一律不注入：管理端页面、布局预览 <code>?preview=1</code>、私密分享页 <code>/blog/share/…</code>、以及带 <code>?nojs=1</code> 打开时——
                  最后一个是逃生阀，脚本写崩了用它打开博客页再回来改。主题的导入导出不会携带这段代码。
                </p>
              </div>
            </>
          )}

          {!loading && cat === 'account' && (
            <>
              {/* 账号密码(P16.9) */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">账号密码</h3>
                <p className="text-[11px] text-gray-400 mb-2">
                  改完密码，<strong>所有设备上已登录的会话都会立刻失效</strong>，这台设备会自动换成新的登录凭据。
                  怀疑登录凭据泄露时，改一次密码就能把它们全部断掉。
                </p>
                <div className="space-y-2">
                  <input
                    type="password"
                    value={pwOld}
                    onChange={(e) => { setPwOld(e.target.value); setPwErr(''); setPwMsg('') }}
                    placeholder="当前密码"
                    autoComplete="current-password"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-emerald-400"
                  />
                  <input
                    type="password"
                    value={pwNew}
                    onChange={(e) => { setPwNew(e.target.value); setPwErr(''); setPwMsg('') }}
                    placeholder="新密码(至少 6 个字符)"
                    autoComplete="new-password"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-emerald-400"
                  />
                  <input
                    type="password"
                    value={pwNew2}
                    onChange={(e) => { setPwNew2(e.target.value); setPwErr(''); setPwMsg('') }}
                    placeholder="再输一次新密码"
                    autoComplete="new-password"
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:border-emerald-400"
                  />
                </div>
                {pwErr && <p className="text-[11px] text-red-500 mt-1.5">{pwErr}</p>}
                {pwMsg && <p className="text-[11px] text-emerald-600 mt-1.5">{pwMsg}</p>}
                <button
                  onClick={changePassword}
                  disabled={pwBusy || !pwOld || !pwNew || !pwNew2}
                  className="mt-2 px-3 py-1.5 text-xs rounded-lg bg-gray-800 text-white hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {pwBusy ? '修改中…' : '修改密码并登出其他设备'}
                </button>
              </div>
            </>
          )}

          {!loading && cat === 'backup' && (
            <>
              {/* 数据备份 */}
              <div>
                <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">数据备份</h3>
                <button
                  onClick={handleExport}
                  disabled={exporting || importing}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 text-left hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span className="text-gray-700 font-medium">{exporting ? '导出中...' : '导出数据 (JSON，不含附件)'}</span>
                </button>
                <button
                  onClick={handleExportZip}
                  disabled={exporting || importing}
                  className="mt-2 w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 text-left hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                  </svg>
                  <span className="text-gray-700 font-medium">{exporting ? '导出中...' : '导出完整备份 (ZIP，含图片/附件)'}</span>
                </button>
                <label className="flex items-center gap-2 mt-2 text-[11px] text-gray-500 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={withVersions}
                    onChange={(e) => setWithVersions(e.target.checked)}
                    className="accent-emerald-500"
                  />
                  同时导出文章历史版本（每篇可能有几十版，文件会大好几倍）
                </label>
                <p className="text-[11px] text-gray-400 mt-1">
                  含全部笔记本、文章（连同公开状态、发布时间与浏览数）、访客评论、对话记录与博客主题/布局配置；
                  不含 API Key、通知渠道等敏感配置。评论里带有评论者邮箱与 IP，这个文件请自己收好。建议定期导出 ZIP 完整备份。
                </p>
                <label className={`mt-2 w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5 text-left hover:border-emerald-400 hover:bg-emerald-50 transition-colors flex items-center gap-2 cursor-pointer ${importing ? 'opacity-50 pointer-events-none' : ''}`}>
                  <svg className="w-4 h-4 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                  </svg>
                  <span className="text-gray-700 font-medium">{importing ? '导入中...' : '导入备份 (JSON / ZIP)'}</span>
                  <input
                    type="file"
                    accept=".json,.zip,application/json,application/zip"
                    className="hidden"
                    disabled={importing}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      e.target.value = ''
                      if (f) handleImportFile(f)
                    }}
                  />
                </label>
                <p className="text-[11px] text-gray-400 mt-1">
                  合并导入笔记本与文章：同名笔记本复用，重复文章自动跳过，导入后自动建立向量索引。ZIP 备份会按原路径恢复附件，笔记中的引用保持有效。
                  评论会跟着它所属的文章一起恢复（含楼中楼的父子关系）；博客主题与布局<b>只在当前没有该项配置时才恢复</b>，不会冲掉你现在的设置。
                </p>
                <button
                  onClick={handleReindex}
                  disabled={importing}
                  className="mt-2 text-xs text-emerald-600 hover:text-emerald-700 hover:underline disabled:opacity-50"
                >
                  补建缺失的向量索引（导入中断/失败后重试）
                </button>
                {importMsg && <p className="text-xs text-emerald-600 mt-2">{importMsg}</p>}

                {/* 自动备份到 R2(P14.2):手动导出要手点，手不点就没有备份 */}
                <div className="mt-4 pt-4 border-t border-gray-100">
                  <h4 className="text-xs font-semibold text-gray-500 mb-2">自动备份到 R2</h4>
                  {backupInfo && !backupInfo.available ? (
                    <p className="text-[11px] text-gray-400">
                      未配置附件存储（R2），自动备份不可用。在 Cloudflare 控制台创建 cfnote-files 桶后重新部署即可。
                    </p>
                  ) : (
                    <>
                      <div className="flex items-center gap-2">
                        <select
                          value={backupInterval}
                          onChange={(e) => setBackupInterval(parseInterval(e.target.value))}
                          className="flex-1 text-sm border border-gray-200 rounded-xl px-3 py-2 focus:outline-none focus:border-emerald-400"
                        >
                          {BACKUP_INTERVALS.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                          ))}
                        </select>
                        <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                          保留
                          <input
                            type="number"
                            min={1}
                            max={MAX_KEEP}
                            value={backupKeep}
                            onChange={(e) => setBackupKeep(parseKeep(e.target.value))}
                            className="w-14 text-sm border border-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:border-emerald-400"
                          />
                          份
                        </label>
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1">
                        {backupInterval === 'off'
                          ? '已关闭。数据只在你手动导出时才有副本。'
                          : `${retentionSpan(backupInterval, backupKeep)}的历史。`}
                        备份只含数据库（笔记、评论、设置、附件清单），
                        <b>不含附件本身</b>——附件已经在 R2 里，再复制一份只是把同一份风险买两遍。频率改动点右下角「保存」后生效。
                      </p>
                      <div className="flex items-center gap-2 mt-2">
                        <button
                          onClick={handleBackupNow}
                          disabled={backupBusy || importing}
                          className="text-xs border border-gray-200 rounded-lg px-3 py-1.5 hover:border-emerald-400 hover:bg-emerald-50 disabled:opacity-50 transition-colors"
                        >
                          {backupBusy ? '备份中...' : '立即备份一次'}
                        </button>
                        {backupInfo?.last_at && (
                          <span className="text-[11px] text-gray-400 truncate">
                            上次 {new Date(backupInfo.last_at).toLocaleString('zh-CN')}
                            {backupInfo.last_size > 0 && `（${formatBytes(backupInfo.last_size)}）`}
                          </span>
                        )}
                      </div>
                      {backupInfo?.last_error && (
                        <p className="text-[11px] text-red-500 mt-1">上次自动备份失败：{backupInfo.last_error}</p>
                      )}
                      {backupMsg && <p className="text-[11px] text-emerald-600 mt-1">{backupMsg}</p>}
                      {backupInfo && backupInfo.files.length > 0 && (
                        <ul className="mt-2 border border-gray-100 rounded-lg divide-y divide-gray-50 max-h-44 overflow-y-auto">
                          {backupInfo.files.map((f) => (
                            <li key={f.name} className="px-3 py-1.5 flex items-center gap-2 text-xs">
                              <span className="text-gray-600 flex-1 truncate">
                                {new Date(f.created_at).toLocaleString('zh-CN')}
                              </span>
                              <span className="text-gray-400 shrink-0">{formatBytes(f.size)}</span>
                              <button onClick={() => handleBackupDownload(f.name)} className="text-emerald-600 hover:underline shrink-0">下载</button>
                              <button onClick={() => handleBackupRestore(f.name)} disabled={importing} className="text-emerald-600 hover:underline disabled:opacity-50 shrink-0">恢复</button>
                              <button onClick={() => handleBackupDelete(f.name)} className="text-gray-400 hover:text-red-500 shrink-0">删除</button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
          </div>
        </div>

        {/* Footer。保存按钮对所有分类共用一个:字段散在几类里,但 PUT /api/settings
            本来就是整份提交,分类只是显示上的分组。窄屏停在分类列表那一层时不显示——
            那一层没有任何可改的字段 */}
        {!loading && cat !== null && (
          <div className="p-4 border-t border-gray-100 flex items-center justify-between gap-3 shrink-0">
            <span className="text-[11px] text-gray-400 min-w-0 truncate">
              {cat === 'files' ? '这一类改完立即生效，不用保存' : '保存对所有分类一起生效'}
            </span>
            <button
              onClick={handleSave}
              disabled={saving || !selected}
              className="px-4 py-2 bg-emerald-500 text-white text-sm font-medium rounded-lg hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
