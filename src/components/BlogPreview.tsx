import { useState, useEffect, useRef, useCallback } from 'react'
import { serializeBlogLayout, type BlogLayout, type PageName } from '../lib/blogLayout'

// 博客布局的实时预览(P12.4):右侧这块就是**真的博客页**,以 /blog?preview=1 装进 iframe。
//
// 为什么不画一份「仿真示意图」:那要为每种模块各画一个缩略形态,加一个模块就得补一份,
// 早晚跟真实渲染走样。iframe 不可能不同步——它就是那个页面。WordPress 的自定义器
// (外观 → 自定义)也是这么做的:右边真站点 iframe,左边控件,改动靠 postMessage 即时下发。
//
// 关键一点是**按真实宽度渲染再整体缩放**:管理端这块区域通常不到 900px,
// 若让 iframe 就按这个宽度渲染,里面的 xl: 断点(1280px)会一直判为窄屏,
// 预览出来的永远是降级后的样子。故 iframe 固定 1400/1000px 宽,再用 transform: scale() 缩到容器里。

const WIDE = 1400
const NARROW = 1000

interface Props {
  /** 当前(可能尚未保存)的布局,改动即时下发给 iframe */
  layout: BlogLayout
  page: PageName
  /** 预览里点了某个模块 → 左侧面板选中它 */
  onSelect: (widgetId: string) => void
}

export default function BlogPreview({ layout, page, onSelect }: Props) {
  const [narrow, setNarrow] = useState(false)
  // undefined = 还没查;null = 没有公开文章(详情页无从预览)
  const [sampleId, setSampleId] = useState<number | null | undefined>(undefined)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const boxRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const ready = useRef(false)

  const width = narrow ? NARROW : WIDE
  const scale = box.w > 0 ? box.w / width : 0
  const frameH = scale > 0 ? Math.max(500, Math.round(box.h / scale)) : 800
  const src = page === 'detail' ? (sampleId ? `/blog/${sampleId}?preview=1` : '') : '/blog?preview=1'

  // 详情页样张:取最新一篇公开文章(公开接口,不需要鉴权),只查一次
  useEffect(() => {
    if (page !== 'detail' || sampleId !== undefined) return
    fetch('/api/blog/posts?limit=1')
      .then((r) => r.json() as Promise<any>)
      .then((j) => setSampleId((j.ok && j.data?.posts?.[0]?.id) || null))
      .catch(() => setSampleId(null))
  }, [page, sampleId])

  // 容器尺寸决定缩放比
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const postLayout = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: 'cfnote-preview-layout', layout: serializeBlogLayout(layout) },
      window.location.origin
    )
  }, [layout])

  // iframe 说「我好了」再下发;之后每次布局变化即时下发(不重载,所以不产生请求)
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      const d = e.data as any
      if (!d || typeof d !== 'object') return
      if (d.type === 'cfnote-preview-ready') { ready.current = true; postLayout() }
      else if (d.type === 'cfnote-preview-select' && typeof d.id === 'string') onSelect(d.id)
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [postLayout, onSelect])

  useEffect(() => { if (ready.current) postLayout() }, [postLayout])
  // 换页面/换样张会重载 iframe,握手要重来
  useEffect(() => { ready.current = false }, [src])

  const tabCls = (on: boolean) =>
    `text-[11px] px-2 py-0.5 rounded ${on ? 'bg-emerald-100 text-emerald-700 font-medium' : 'text-gray-500 hover:bg-gray-100'}`

  return (
    <div className="flex-1 min-w-0 flex flex-col border-l border-gray-100">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2 shrink-0">
        <span className="text-[11px] text-gray-400">实时预览</span>
        <button onClick={() => setNarrow(false)} className={tabCls(!narrow)}>宽屏 {WIDE}</button>
        <button onClick={() => setNarrow(true)} className={tabCls(narrow)}>窄屏 {NARROW}</button>
        <span className="text-[11px] text-gray-300 tabular-nums">{scale > 0 ? `${Math.round(scale * 100)}%` : ''}</span>
        <button
          onClick={() => { ready.current = false; frameRef.current?.contentWindow?.location.reload() }}
          className="ml-auto text-[11px] text-gray-400 hover:text-emerald-600"
          title="重新加载预览(文章内容有变动时)"
        >
          刷新
        </button>
      </div>

      <div ref={boxRef} className="flex-1 min-h-0 overflow-hidden bg-gray-100 relative">
        {!src ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-gray-400 px-4 text-center">
            还没有公开文章,详情页无法预览。先在笔记里公开一篇。
          </div>
        ) : scale > 0 ? (
          <iframe
            ref={frameRef}
            src={src}
            title="博客预览"
            style={{ width, height: frameH, transform: `scale(${scale})`, transformOrigin: 'top left' }}
            className="border-0 bg-white"
          />
        ) : null}
      </div>

      <p className="px-3 py-1.5 text-[11px] text-gray-400 border-t border-gray-100 shrink-0">
        预览里点任意模块可在左侧编辑它;预览中的链接不会跳转,页面切换用左上角页签。
      </p>
    </div>
  )
}
