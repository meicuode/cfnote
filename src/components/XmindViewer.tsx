import { useState, useEffect, useRef, useCallback } from 'react'
import JSZip from 'jszip'
import MindMap from 'simple-mind-map'
import Drag from 'simple-mind-map/src/plugins/Drag.js'
import Export from 'simple-mind-map/src/plugins/Export.js'
import NodeImgAdjust from 'simple-mind-map/src/plugins/NodeImgAdjust.js'
import { nodeIconList } from 'simple-mind-map/src/svg/icons.js'
import ConfirmDialog from './ConfirmDialog'
import { downscaleToPng, downscaleForNode, THUMB_MAX_BYTES } from '../lib/thumbnail'
import {
  parseZen, parseXml, buildContentJson, assembleXmindZip, extractResources, createSaveContext,
  emptyResources, type XmindResources, type XmindSheet as Sheet,
} from '../lib/xmind'

// Drag 拖拽节点;Export 保存时生成缩略图;NodeImgAdjust 拖拽调整节点图片尺寸
MindMap.usePlugin(Drag)
MindMap.usePlugin(Export)
MindMap.usePlugin(NodeImgAdjust)

interface Props {
  url: string
  name: string
  token: string
  onClose: () => void
}

interface MenuState {
  x: number
  y: number
  uid: string
  text: string
  note: string
  link: string
  hasImage: boolean
  isRoot: boolean
}

const clampX = (x: number, w: number) => Math.max(8, Math.min(x, window.innerWidth - w - 8))
const clampY = (y: number, h: number) => Math.max(8, Math.min(y, window.innerHeight - h - 8))

// 全屏预览/编辑 .xmind:兼容 XMind 8(XML)与 Zen/2020+(JSON),多画布;
// 编辑能力:文本/层级/拖拽 + 右键菜单(备注/超链接/图片/图标/增删节点);
// 保存以 Zen 格式原地覆盖 R2 中的文件,未变更的富属性保持原样(XMind 8 来源会转存为新版格式)。
// 解析/保存/资源管理的纯逻辑在 src/lib/xmind.ts(tests/xmind.test.ts 覆盖)。
export default function XmindViewer({ url, name, token, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mindMapRef = useRef<MindMap | null>(null)
  const originalZenRef = useRef<any>(null) // 原始 content.json(保留主题/样式等未知字段)
  const originalZipRef = useRef<JSZip | null>(null) // 原始 zip(保存时保留资源等其他条目)
  const resourcesRef = useRef<XmindResources>(emptyResources()) // zip 内图片资源 ↔ dataURL 映射
  const activeRef = useRef<any[]>([]) // 当前选中节点(粘贴图片的目标)
  const imageTargetUidRef = useRef<string>('') // 图片选择器要写入的节点
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [sheets, setSheets] = useState<Sheet[]>([])
  const [active, setActive] = useState(0)
  const [editMode, setEditMode] = useState(false)
  const [edited, setEdited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedTip, setSavedTip] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 弹层
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [noteDialog, setNoteDialog] = useState<{ uid: string; text: string } | null>(null)
  const [notePopup, setNotePopup] = useState<{ x: number; y: number; text: string } | null>(null)
  const [linkDialog, setLinkDialog] = useState<{ uid: string; url: string } | null>(null)
  const [iconPicker, setIconPicker] = useState<{ x: number; y: number; uid: string } | null>(null)
  const [iconTick, setIconTick] = useState(0) // execCommand 后驱动图标选中态刷新
  const [lightbox, setLightbox] = useState<string | null>(null)

  const getNode = useCallback((uid: string) => (mindMapRef.current as any)?.renderer?.findNodeByUid?.(uid), [])

  const closeOverlays = useCallback(() => {
    setMenu(null)
    setNotePopup(null)
    setIconPicker(null)
  }, [])

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
      if (e.key !== 'Escape') return
      // 先关闭浮层/弹窗,再考虑关闭查看器;编辑模式下 Esc 交给画布
      if (menu || notePopup || iconPicker || lightbox || noteDialog || linkDialog) {
        closeOverlays()
        setLightbox(null)
        setNoteDialog(null)
        setLinkDialog(null)
        return
      }
      if (!editMode) requestClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [requestClose, editMode, menu, notePopup, iconPicker, lightbox, noteDialog, linkDialog, closeOverlays])

  // 点击浮层外部关闭右键菜单/图标选择器/备注气泡
  useEffect(() => {
    if (!menu && !iconPicker && !notePopup) return
    const handler = (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.('.xm-popover')) return
      closeOverlays()
    }
    const t = setTimeout(() => {
      document.addEventListener('mousedown', handler)
      document.addEventListener('contextmenu', handler)
    }, 10)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('contextmenu', handler)
    }
  }, [menu, iconPicker, notePopup, closeOverlays])

  // 下载并解析文件(cache: reload 确保编辑保存后再次打开取到最新内容)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(url, { cache: 'reload' })
        if (!res.ok) throw new Error(`文件下载失败 (${res.status})`)
        const zip = await JSZip.loadAsync(await res.arrayBuffer())
        const resources = await extractResources(zip)
        let parsed: Sheet[]
        const contentJson = zip.file('content.json')
        if (contentJson) {
          const json = JSON.parse(await contentJson.async('string'))
          originalZenRef.current = json
          originalZipRef.current = zip
          parsed = parseZen(json, resources)
        } else {
          const contentXml = zip.file('content.xml')
          if (!contentXml) throw new Error('无法识别的 XMind 文件格式')
          // XMind 8 会转存为全新 Zen 包:旧 zip 的 xap 引用不可复用,图片保存时重新落盘
          resources.xapByDataUrl.clear()
          parsed = parseXml(await contentXml.async('string'), resources)
        }
        resourcesRef.current = resources
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

    const onActive = (_n: any, list: any[]) => { activeRef.current = list || [] }
    mm.on('node_active', onActive)

    // 右键菜单:编辑模式提供节点操作;预览模式提供复制文字
    const onContextMenu = (e: any, node: any) => {
      e?.preventDefault?.()
      const d = node?.nodeData?.data || {}
      setNotePopup(null)
      setIconPicker(null)
      setMenu({
        x: clampX(e?.clientX ?? 100, 200),
        y: clampY(e?.clientY ?? 100, editMode ? 350 : 60),
        uid: d.uid || '',
        text: d.text || '',
        note: d.note || '',
        link: d.hyperlink || '',
        hasImage: !!d.image,
        isRoot: !!node?.isRoot,
      })
    }
    mm.on('node_contextmenu', onContextMenu)

    // 点击备注图标:预览显示内容,编辑打开编辑器
    const onNoteClick = (node: any, e: any) => {
      const d = node?.nodeData?.data || {}
      if (editMode) {
        setNoteDialog({ uid: d.uid || '', text: d.note || '' })
      } else {
        setNotePopup({ x: clampX(e?.clientX ?? 100, 300), y: clampY((e?.clientY ?? 100) + 12, 200), text: d.note || '' })
      }
    }
    mm.on('node_note_click', onNoteClick)

    // 双击节点图片放大预览
    const onImgDblclick = (node: any) => {
      const img = node?.nodeData?.data?.image
      if (img) setLightbox(img)
    }
    mm.on('node_img_dblclick', onImgDblclick)

    mindMapRef.current = mm
    return () => {
      try {
        if (editMode) mm.off('data_change', onChange)
        mm.off('node_active', onActive)
        mm.off('node_contextmenu', onContextMenu)
        mm.off('node_note_click', onNoteClick)
        mm.off('node_img_dblclick', onImgDblclick)
      } catch { /* */ }
      try { mm.destroy() } catch { /* 已销毁 */ }
      mindMapRef.current = null
      activeRef.current = []
    }
  }, [sheets, active, editMode])

  // 编辑模式:粘贴剪贴板图片到选中节点
  useEffect(() => {
    if (!editMode) return
    const handler = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      let imageItem: DataTransferItem | null = null
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) { imageItem = item; break }
      }
      const node = activeRef.current[0]
      if (!imageItem || !node) return
      e.preventDefault()
      const blob = imageItem.getAsFile()
      if (!blob) return
      const out = await downscaleForNode(blob)
      if (!out) return
      mindMapRef.current?.execCommand('SET_NODE_IMAGE', node, {
        url: out.dataUrl, title: '', width: out.width, height: out.height,
      })
    }
    window.addEventListener('paste', handler)
    return () => window.removeEventListener('paste', handler)
  }, [editMode])

  const switchSheet = (i: number) => {
    if (i === active) return
    closeOverlays()
    syncCurrent()
    setActive(i)
  }

  const toggleMode = () => {
    closeOverlays()
    setNoteDialog(null)
    setLinkDialog(null)
    syncCurrent()
    setEditMode((m) => !m)
  }

  // ---- 右键菜单动作(经 uid 取最新节点实例,避免持有过期引用) ----

  const copyText = async (text: string) => {
    setMenu(null)
    try { await navigator.clipboard.writeText(text) } catch { /* 剪贴板不可用 */ }
  }

  const menuExec = (uid: string, fn: (node: any) => void) => {
    setMenu(null)
    const node = getNode(uid)
    if (node) fn(node)
  }

  const setNodeNote = (uid: string, text: string) => {
    const node = getNode(uid)
    if (node) mindMapRef.current?.execCommand('SET_NODE_NOTE', node, text)
    setNoteDialog(null)
  }

  const setNodeLink = (uid: string, link: string) => {
    const node = getNode(uid)
    if (node) mindMapRef.current?.execCommand('SET_NODE_HYPERLINK', node, link.trim(), '')
    setLinkDialog(null)
  }

  const pickImage = (uid: string) => {
    setMenu(null)
    imageTargetUidRef.current = uid
    fileInputRef.current?.click()
  }

  const onImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    const node = getNode(imageTargetUidRef.current)
    if (!file || !node) return
    if (!file.type.startsWith('image/')) return
    const out = await downscaleForNode(file)
    if (!out) { setError('图片解析失败'); setTimeout(() => setError(''), 3000); return }
    mindMapRef.current?.execCommand('SET_NODE_IMAGE', node, {
      url: out.dataUrl, title: '', width: out.width, height: out.height,
    })
  }

  const toggleIcon = (uid: string, key: string) => {
    const node = getNode(uid)
    if (!node) return
    const cur: string[] = node.nodeData?.data?.icon || []
    let next: string[]
    if (cur.includes(key)) {
      next = cur.filter((k) => k !== key)
    } else {
      const group = key.split('_')[0]
      next = cur.filter((k) => !k.startsWith(group + '_'))
      next.push(key)
    }
    mindMapRef.current?.execCommand('SET_NODE_ICON', node, next)
    setIconTick((t) => t + 1)
  }

  const handleSave = async () => {
    if (saving) return
    syncCurrent()
    setSaving(true)
    setError('')
    try {
      // Zen 来源:在原始 JSON 上替换各画布 rootTopic,未变更的节点富属性保持原样;
      // 新增图片经 ctx 收集为 zip 资源,保存时回收孤儿资源(逻辑与测试见 src/lib/xmind.ts)
      const ctx = createSaveContext(resourcesRef.current)
      const json = buildContentJson(originalZenRef.current, sheets, ctx)

      // 当前画布截图 → 降采样为限宽 480px 的小图(整画布原尺寸 PNG 可达数 MB,
      // 直接嵌入会让 .xmind 体积大幅膨胀);超过上限则放弃缩略图,不阻塞保存
      let thumbBytes: Uint8Array | null = null
      try {
        const dataUrl: string = await (mindMapRef.current as any)?.export('png', false)
        if (dataUrl) thumbBytes = await downscaleToPng(dataUrl, 480)
        if (thumbBytes && thumbBytes.length > THUMB_MAX_BYTES) thumbBytes = null
      } catch { /* 截图失败:保留原缩略图 */ }

      const zip = assembleXmindZip(originalZipRef.current, json, thumbBytes, ctx)
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
      if (thumbBytes) {
        // 边车缩略图供文章内卡片预览,失败静默
        fetch(`${url}.thumb.png`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
          body: thumbBytes as unknown as BodyInit,
        }).catch(() => {})
      }
      originalZipRef.current = zip
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

  const menuItemCls = 'w-full px-3 py-1.5 text-left text-sm text-gray-700 hover:bg-gray-100 flex items-center gap-2'
  void iconTick // 图标 execCommand 不触发 React 渲染,经 setIconTick 驱动选中态刷新
  const pickerNode = iconPicker ? getNode(iconPicker.uid) : null
  const pickerIcons: string[] = pickerNode?.nodeData?.data?.icon || []

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
          <span className="hidden lg:inline text-[11px] text-gray-400 mr-1">
            双击编辑 · Tab 子节点 · Enter 同级 · Delete 删除 · 拖拽移动 · 右键更多
          </span>
        )}
        {error && <span className="text-xs text-red-500 truncate max-w-[220px]" title={error}>{error}</span>}
        {savedTip && <span className="text-xs text-emerald-600">已保存</span>}

        {editMode && (
          <>
            <button
              onClick={() => mindMapRef.current?.execCommand('BACK')}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-emerald-600 transition-colors"
              title="撤销 (Ctrl+Z)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a4 4 0 014 4v2M3 10l4 4m-4-4l4-4" />
              </svg>
            </button>
            <button
              onClick={() => mindMapRef.current?.execCommand('FORWARD')}
              className="p-1.5 rounded hover:bg-gray-100 text-gray-500 hover:text-emerald-600 transition-colors"
              title="重做 (Ctrl+Y)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 10H11a4 4 0 00-4 4v2m14-6l-4 4m4-4l-4-4" />
              </svg>
            </button>
          </>
        )}

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

      {/* 右键菜单 */}
      {menu && (
        <div
          className="xm-popover fixed z-[80] bg-white rounded-xl shadow-xl border border-gray-200 py-1.5 min-w-[176px]"
          style={{ left: menu.x, top: menu.y }}
        >
          {editMode && (
            <>
              <button
                className={menuItemCls}
                onClick={() => menuExec(menu.uid, (node) => mindMapRef.current?.execCommand('INSERT_CHILD_NODE', true, [node]))}
              >
                <span className="w-4 text-center text-emerald-600">＋</span>添加子节点
                <span className="ml-auto text-[10px] text-gray-400">Tab</span>
              </button>
              {!menu.isRoot && (
                <button
                  className={menuItemCls}
                  onClick={() => menuExec(menu.uid, (node) => mindMapRef.current?.execCommand('INSERT_NODE', true, [node]))}
                >
                  <span className="w-4 text-center text-emerald-600">≡</span>添加同级节点
                  <span className="ml-auto text-[10px] text-gray-400">Enter</span>
                </button>
              )}
              {!menu.isRoot && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                  onClick={() => menuExec(menu.uid, (node) => mindMapRef.current?.execCommand('REMOVE_NODE', [node]))}
                >
                  <span className="w-4 text-center">✕</span>删除节点
                  <span className="ml-auto text-[10px] text-gray-400">Del</span>
                </button>
              )}
              <div className="h-px bg-gray-100 my-1" />
              <button
                className={menuItemCls}
                onClick={() => { setMenu(null); setNoteDialog({ uid: menu.uid, text: menu.note }) }}
              >
                <span className="w-4 text-center">📝</span>{menu.note ? '编辑备注' : '添加备注'}
              </button>
              <button
                className={menuItemCls}
                onClick={() => { setMenu(null); setLinkDialog({ uid: menu.uid, url: menu.link }) }}
              >
                <span className="w-4 text-center">🔗</span>{menu.link ? '编辑链接' : '添加链接'}
              </button>
              <button className={menuItemCls} onClick={() => pickImage(menu.uid)}>
                <span className="w-4 text-center">🖼️</span>{menu.hasImage ? '更换图片' : '添加图片'}
              </button>
              {menu.hasImage && (
                <button
                  className="w-full px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                  onClick={() =>
                    menuExec(menu.uid, (node) =>
                      mindMapRef.current?.execCommand('SET_NODE_IMAGE', node, { url: '', title: '', width: 0, height: 0 })
                    )
                  }
                >
                  <span className="w-4 text-center">🖼️</span>删除图片
                </button>
              )}
              <button
                className={menuItemCls}
                onClick={() => {
                  setMenu(null)
                  setIconPicker({ x: clampX(menu.x, 300), y: clampY(menu.y, 340), uid: menu.uid })
                }}
              >
                <span className="w-4 text-center">⭐</span>设置图标
              </button>
              <div className="h-px bg-gray-100 my-1" />
            </>
          )}
          <button className={menuItemCls} onClick={() => copyText(menu.text)}>
            <span className="w-4 text-center">📋</span>复制文字
          </button>
          {!editMode && menu.note && (
            <button
              className={menuItemCls}
              onClick={() => {
                setNotePopup({ x: menu.x, y: menu.y, text: menu.note })
                setMenu(null)
              }}
            >
              <span className="w-4 text-center">📝</span>查看备注
            </button>
          )}
        </div>
      )}

      {/* 备注查看气泡(预览模式) */}
      {notePopup && (
        <div
          className="xm-popover fixed z-[80] bg-white rounded-xl shadow-xl border border-gray-200 w-[300px] max-h-[240px] flex flex-col"
          style={{ left: notePopup.x, top: notePopup.y }}
        >
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between">
            <span className="text-xs font-medium text-gray-500">📝 节点备注</span>
            <button onClick={() => setNotePopup(null)} className="text-gray-400 hover:text-gray-600 text-xs px-1">✕</button>
          </div>
          <div className="p-3 text-sm text-gray-700 overflow-y-auto whitespace-pre-wrap break-words select-text">
            {notePopup.text}
          </div>
        </div>
      )}

      {/* 图标选择器 */}
      {iconPicker && (
        <div
          className="xm-popover fixed z-[80] bg-white rounded-xl shadow-xl border border-gray-200 w-[300px] max-h-[340px] overflow-y-auto p-3"
          style={{ left: iconPicker.x, top: iconPicker.y }}
        >
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-gray-100">
            <span className="text-xs font-medium text-gray-500">节点图标(点击切换)</span>
            <button
              onClick={() => {
                const node = getNode(iconPicker.uid)
                if (node) mindMapRef.current?.execCommand('SET_NODE_ICON', node, [])
                setIconTick((t) => t + 1)
              }}
              className="text-[11px] px-2 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
            >
              清除全部
            </button>
          </div>
          {nodeIconList.map((group) => (
            <div key={group.type} className="mb-2">
              <p className="text-[11px] text-gray-400 mb-1">{group.name}</p>
              <div className="flex flex-wrap gap-1">
                {group.list.map((item) => {
                  const key = `${group.type}_${item.name}`
                  const selected = pickerIcons.includes(key)
                  return (
                    <button
                      key={key}
                      onClick={() => toggleIcon(iconPicker.uid, key)}
                      className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors [&_svg]:w-5 [&_svg]:h-5 ${
                        selected ? 'bg-emerald-100 ring-1 ring-emerald-400' : 'hover:bg-gray-100'
                      }`}
                      title={`${group.name} ${item.name}`}
                      dangerouslySetInnerHTML={{ __html: item.icon }}
                    />
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 备注编辑弹窗 */}
      {noteDialog && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onMouseDown={() => setNoteDialog(null)}>
          <div
            className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw] p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">📝 节点备注</h3>
            <textarea
              autoFocus
              value={noteDialog.text}
              onChange={(e) => setNoteDialog({ ...noteDialog, text: e.target.value })}
              placeholder="输入备注内容,留空则移除备注"
              className="w-full h-32 px-3 py-2 text-sm text-gray-800 bg-gray-50 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-400 resize-none"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setNoteDialog(null)}
                className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => setNodeNote(noteDialog.uid, noteDialog.text)}
                className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
              >
                保存备注
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 链接编辑弹窗 */}
      {linkDialog && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40" onMouseDown={() => setLinkDialog(null)}>
          <div
            className="bg-white rounded-2xl shadow-2xl w-[440px] max-w-[92vw] p-5"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">🔗 节点链接</h3>
            <input
              autoFocus
              type="url"
              value={linkDialog.url}
              onChange={(e) => setLinkDialog({ ...linkDialog, url: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') setNodeLink(linkDialog.uid, linkDialog.url) }}
              placeholder="https://example.com(留空则移除链接)"
              className="w-full px-3 py-2 text-sm text-gray-800 bg-gray-50 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-emerald-400"
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                onClick={() => setLinkDialog(null)}
                className="px-3 py-1.5 text-xs rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => setNodeLink(linkDialog.uid, linkDialog.url)}
                className="px-3 py-1.5 text-xs rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
              >
                保存链接
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 图片放大预览 */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/80"
          onClick={() => setLightbox(null)}
        >
          <img
            src={lightbox}
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
            alt="节点图片"
          />
          <button className="absolute top-4 right-4 text-white/80 hover:text-white p-2" onClick={() => setLightbox(null)}>
            <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* 隐藏的节点图片选择 input */}
      <input ref={fileInputRef} type="file" accept="image/*" onChange={onImageSelected} className="hidden" />

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
