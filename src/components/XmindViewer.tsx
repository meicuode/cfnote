import { useState, useEffect, useRef } from 'react'
import JSZip from 'jszip'
import MindMap from 'simple-mind-map'

interface Props {
  url: string
  name: string
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
  return sheets
    .filter((s: any) => s && s.rootTopic)
    .map((s: any, i: number) => ({
      name: s.title || `画布 ${i + 1}`,
      root: topicToNode(s.rootTopic),
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

// 全屏只读预览 .xmind 文件:兼容 XMind 8(XML)与 Zen/2020+(JSON),多画布可切换
export default function XmindViewer({ url, name, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mindMapRef = useRef<any>(null)
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [active, setActive] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // 下载并解析文件
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`文件下载失败 (${res.status})`)
        const zip = await JSZip.loadAsync(await res.arrayBuffer())
        let parsed: Sheet[]
        const contentJson = zip.file('content.json')
        if (contentJson) {
          parsed = parseZen(JSON.parse(await contentJson.async('string')))
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

  // 渲染当前画布
  useEffect(() => {
    if (sheets.length === 0 || !containerRef.current) return
    const mm = new MindMap({
      el: containerRef.current,
      data: sheets[active].root,
      readonly: true,
      mousewheelAction: 'zoom',
      initRootNodePosition: ['center', 'center'],
    } as any)
    mindMapRef.current = mm
    return () => { try { mm.destroy() } catch { /* 已销毁 */ } mindMapRef.current = null }
  }, [sheets, active])

  return (
    <div className="fixed inset-0 z-[70] bg-white flex flex-col">
      {/* Header */}
      <div className="h-12 border-b border-gray-200 flex items-center px-4 shrink-0 gap-3">
        <svg className="w-5 h-5 text-emerald-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
        </svg>
        <span className="text-sm font-medium text-gray-900 truncate flex-1">{name}</span>
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
        <button onClick={onClose} className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600">
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
        {error && (
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
              onClick={() => setActive(i)}
              className={`px-3 py-1 rounded text-xs whitespace-nowrap transition-colors ${
                i === active ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
