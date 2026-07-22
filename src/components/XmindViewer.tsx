import { useState, useEffect, useRef, useCallback } from 'react'
import JSZip from 'jszip'
import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import ConfirmDialog from './ConfirmDialog'

// 拖拽节点调整层级/顺序(编辑模式)
MindMap.usePlugin(Drag)

interface Props {
  url: string
  name: string
  token: string
  onClose: () => void
}

interface Sheet { name: string; root: any }

// ---- XMind Zen / 2020+ (content.json) ----
function topicToNode(t: any): any {
  return {
    data: { text: t?.title || '' },
    children: (t?.children?.attached || []).map(topicToNode),
  }
}

function parseZen(json: any): Sheet[] {
  const sheets = Array.isArray(json) ? json : [json]
  // 不过滤空画布:保存时按下标与原始 JSON 一一对应
  return sheets.map((s: any, i: number) => ({
    name: s?.title || `画布 ${i + 1}`,
    root: s?.rootTopic ? topicToNode(s.rootTopic) : { data: { text: s?.title || '主题' }, children: [] },
  }))
}

// ---- XMind 8 (content.xml) ----
function xmlTopicToNode(el: Element): any {
  const title = Array.from(el.children).find((c) => c.tagName === 'title')?.textContent || ''
  const childrenEl = Array.from(el.children).find((c) => c.tagName === 'children')
  const topics: Element[] = []
  if (childrenEl) {
    for (const ts of Array.from(childrenEl.children)) {
      if (ts.tagName === 'topics' && ts.getAttribute('type') === 'attached') {
        topics.push(...Array.from(ts.children).filter((c) => c.tagName === 'topic'))
      }
    }
  }
  return { data: { text: title }, children: topics.map(xmlTopicToNode) }
}

function parseXml(xml: string): Sheet[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  return Array.from(doc.getElementsByTagName('sheet')).map((s, i) => {
    const topic = Array.from(s.children).find((c) => c.tagName === 'topic')
    const title = Array.from(s.children).find((c) => c.tagName === 'title')?.textContent
    return {
      name: title || `画布 ${i + 1}`,
      root: topic ? xmlTopicToNode(topic) : { data: { text: '(空画布)' }, children: [] },
    }
  })
}

// ---- 保存:渲染树 → XMind Zen topic 结构 ----
function nodeToTopic(n: any): any {
  const topic: any = {
    id: crypto.randomUUID(),
    class: 'topic',
    title: n?.data?.text || '',
  }
  if (n?.children?.length) topic.children = { attached: n.children.map(nodeToTopic) }
  return topic
}

// 全屏预览/编辑 .xmind:兼容 XMind 8(XML)与 Zen/2020+(JSON),多画布;
// 编辑保存时以 Zen 格式原地覆盖 R2 中的文件(XMind 8 来源会转存为新版格式)。
export default function XmindViewer({ url, name, token, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mindMapRef = useRef<MindMap | null>(null)
  const originalZenRef = useRef<any>(null) // 原始 content.json(保留主题/样式等未知字段)
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [active, setActive] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [edited, setEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedTip, setSavedTip] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 把当前画布的最新编辑同步回 sheets(切换画布/模式/保存前调用)
  const syncCurrent = useCallback(() => {
    const mm = mindMapRef.current
    if (!mm || sheets.length === 0) return
    try {
      const data = mm.getData()
      if (data) sheets[active].root = data
    } catch { /* 实例已销毁 */ }
  }, [sheets, active])

  const requestClose = useCallback(() => {
    if (edited) setConfirmClose(true)
    else onClose()
  }, [edited, onClose])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // 编辑模式下 Esc 交给画布(取消节点选中等),仅预览模式下关闭
      if (e.key === 'Escape' && !editMode) requestClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [requestClose, editMode])

  // 下载并解析文件(cache: reload 确保编辑保存后再次打开取到最新内容)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(url, { cache: 'reload' })
        if (!res.ok) throw new Error(`文件下载失败 (${res.status})`)
        const zip = await JSZip.loadAsync(await res.arrayBuffer())
        let parsed: Sheet[]
        const contentJson = zip.file('content.json')
        if (contentJson) {
          const json = JSON.parse(await contentJson.async('string'))
          originalZenRef.current = json
          parsed = parseZen(json)
        } else {
          const contentXml = zip.file('content.xml')
          if (!contentXml) throw new Error('无法识别的 XMind 文件格式')
          parsed = parseXml(await contentXml.async('string'))
        }
        if (parsed.length === 0) throw new Error('文件中没有可显示的画布')
        if (!cancelled) { setSheets(parsed); setLoading(false) }
      } catch (e: any) {
        if (!cancelled) { setError(e.message || '解析失败'); setLoading(false) }
      }
    })()
    return () => { cancelled = true }
  }, [url])

  // 渲染当前画布(切换画布或模式时重建实例;重建前上层已 syncCurrent)
  useEffect(() => {
    if (sheets.length === 0 || !containerRef.current) return
    const mm = new MindMap({
      el: containerRef.current,
      data: sheets[active].root,
      readonly: !editMode,
      mousewheelAction: 'zoom',
      initRootNodePosition: ['center', 'center'],
    } as unknown as Record<string, unknown>)
    const onChange = () => setEdited(true)
    if (editMode) mm.on('data_change', onChange)
    mindMapRef.current = mm
    return () => {
      if (editMode) { try { mm.off('data_change', onChange) } catch { /* */ } }
      try { mm.destroy() } catch { /* 已销毁 */ }
      mindMapRef.current = null
    }
  }, [sheets, active, editMode])

  const switchSheet = (i: number) => {
    if (i === active) return
    syncCurrent()
    setActive(i)
  }

  const toggleMode = () => {
    syncCurrent()
    setEditMode((m) => !m)
  }

  const handleSave = async () => {
    if (saving) return
    syncCurrent()
    setSaving(true)
    setError('')
    try {
      // 构造 content.json:Zen 来源在原始 JSON 上仅替换各画布的 rootTopic(保留主题样式等),
      // XMind 8 来源生成全新 Zen 结构
      let json: any
      if (originalZenRef.current) {
        json = originalZenRef.current
        const arr = Array.isArray(json) ? json : [json]
        arr.forEach((s: any, i: number) => {
          if (sheets[i]) s.rootTopic = nodeToTopic(sheets[i].root)
        })
      } else {
        json = sheets.map((s) => ({
          id: crypto.randomUUID(),
          class: 'sheet',
          title: s.name,
          rootTopic: nodeToTopic(s.root),
        }))
      }

      const zip = new JSZip()
      zip.file('content.json', JSON.stringify(json))
      zip.file('metadata.json', JSON.stringify({ creator: { name: 'cfnote' } }))
      zip.file('manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }))
      const blob = await zip.generateAsync({ type: 'blob' })

      const res = await fetch(url, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/vnd.xmind.workbook',
        },
        body: blob,
      })
      const j: any = await res.json()
      if (!j.ok) throw new Error(j.error || `保存失败 (${res.status})`)
      originalZenRef.current = json
      setEdited(false)
      setSavedTip(true)
      setTimeout(() => setSavedTip(false), 2000)
    } catch (e: any) {
      setError(e.message)
      setTimeout(() => setError(''), 5000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] bg-white flex flex-col">
      {/* Header */}
      <div className="h-12 border-b border-gray-200 flex items-center px-4 shrink-0 gap-2">
        <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-sm font-medium text-gray-900 truncate flex-1">
          {name}
          {edited && <span className="text-amber-500 ml-1" title="有未保存的修改">●</span>}
        </span>

        {editMode && (
          <span className="hidden md:inline text-[11px] text-gray-400 mr-1">
            双击编辑文本 · Tab 子节点 · Enter 同级节点 · Delete 删除 · 拖拽移动节点
          </span>
        )}
        {error && <span className="text-xs text-red-500 truncate max-w-[220px]" title={error}>{error}</span>}
        {savedTip && <span className="text-xs text-emerald-600">已保存</span>}

        {!loading && !error && sheets.length > 0 && (
          <button
            onClick={toggleMode}
            className={`text-xs px-2.5 py-1 rounded-lg transition-colors ${
              editMode ? 'bg-gray-100 text-gray-600 hover:bg-gray-200' : 'bg-emerald-500 text-white hover:bg-emerald-600'
            }`}
          >
            {editMode ? '完成编辑' : '编辑'}
          </button>
        )}
        {editMode && (
          <button
            onClick={handleSave}
            disabled={saving || !edited}
            className="text-xs px-2.5 py-1 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 transition-colors"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        )}
        <button
          onClick={() => mindMapRef.current?.view?.fit()}
          className="text-xs text-gray-500 hover:text-emerald-600 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
          title="适应窗口"
        >
          适应窗口
        </button>
        <a
          href={url}
          download={name}
          className="text-xs text-gray-500 hover:text-emerald-600 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
        >
          下载
        </a>
        <button onClick={requestClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative overflow-hidden">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <div className="inline-block w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500 mt-2">正在解析思维导图...</p>
            </div>
          </div>
        )}
        {error && sheets.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-sm text-red-500 bg-red-50 rounded-lg px-4 py-2">{error}</p>
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>

      {/* Sheet tabs */}
      {sheets.length > 1 && (
        <div className="h-9 border-t border-gray-200 flex items-center px-2 gap-1 shrink-0 overflow-x-auto">
          {sheets.map((s, i) => (
            <button
              key={i}
              onClick={() => switchSheet(i)}
              className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                i === active ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {confirmClose && (
        <ConfirmDialog
          title="放弃未保存的修改？"
          message="思维导图有尚未保存的编辑，关闭后将丢失这些修改。"
          confirmText="放弃并关闭"
          onConfirm={onClose}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </div>
  )
}
