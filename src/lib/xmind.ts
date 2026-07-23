import JSZip from 'jszip'

// XMind 文件的解析与保存纯逻辑(与 UI 解耦,tests/xmind.test.ts 覆盖):
// - 解析:Zen/2020+ 的 content.json 与 XMind 8 的 content.xml → 渲染树,
//   节点级富属性映射为 simple-mind-map 字段(备注 note/超链接 hyperlink/图片 image/标记 icon)
// - 保存:渲染树 → content.json。通过 data.uid 找回原始 topic 合并,
//   遵循"未变更的字段保持原样"原则(如备注的 html 变体、无法映射的 markers 都不动),防止保存丢数据
// - 图片:zip 内 resources/ 资源 ↔ dataURL 互转,新图片按内容哈希写入并去重,保存时回收未引用资源
// - 组装 zip:Zen 来源基于原 zip 覆盖(保留资源等其他条目),控制体积只增不炸

export interface XmindSheet {
  name: string
  root: any
}

// zip 内资源(resources/、attachments/)提取结果,解析与保存共用
export interface XmindResources {
  // 资源路径(如 resources/img1.png)→ dataURL
  byPath: Map<string, string>
  // dataURL → 原始引用串(如 xap:resources/img1.png):保存时识别"图片未变更/重复"避免重复写入
  xapByDataUrl: Map<string, string>
}

const RESOURCE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp',
}

export function emptyResources(): XmindResources {
  return { byPath: new Map(), xapByDataUrl: new Map() }
}

// 从 zip 提取 resources/ 与 attachments/ 下的图片为 dataURL(供节点图片显示)
export async function extractResources(zip: JSZip): Promise<XmindResources> {
  const res = emptyResources()
  const files: { path: string; file: JSZip.JSZipObject }[] = []
  zip.forEach((path, file) => {
    if (file.dir) return
    if (path.startsWith('resources/') || path.startsWith('attachments/')) files.push({ path, file })
  })
  for (const { path, file } of files) {
    const ext = path.split('.').pop()?.toLowerCase() || ''
    const mime = RESOURCE_MIME[ext]
    if (!mime) continue
    try {
      const b64 = await file.async('base64')
      const dataUrl = `data:${mime};base64,${b64}`
      res.byPath.set(path, dataUrl)
      if (!res.xapByDataUrl.has(dataUrl)) res.xapByDataUrl.set(dataUrl, `xap:${path}`)
    } catch { /* 单个资源坏了不影响整体 */ }
  }
  return res
}

// 按 xap:/xmind: 引用找资源:先按完整路径,再退化按文件名结尾匹配(兼容路径前缀差异)
function resolveResource(src: string, res?: XmindResources): string | null {
  if (!res) return null
  const path = src.replace(/^xap:/, '').replace(/^xmind:/, '')
  const hit = res.byPath.get(path)
  if (hit) return hit
  const fileName = path.split('/').pop()
  if (!fileName) return null
  for (const [p, dataUrl] of res.byPath) {
    if (p.endsWith('/' + fileName)) return dataUrl
  }
  return null
}

// ---- XMind markers ↔ simple-mind-map icon 映射 ----
// XMind 原生 marker 走 priority-N ↔ priority_N 精确互转(XMind 客户端可识别);
// smm 独有分组(progress/expression/sign)原样透传,cfnote 内部往返无损;
// 其余 XMind marker(flag-red/task-* 等)不展示,保存时原样保留在 markers 里不丢失。
const SMM_ICON_RE = /^(priority|progress|expression|sign)_[A-Za-z0-9]+$/

export function markerToIcon(markerId: string): string | null {
  const pri = /^priority-([1-9]|10)$/.exec(markerId)
  if (pri) return `priority_${pri[1]}`
  if (SMM_ICON_RE.test(markerId)) return markerId
  return null
}

export function iconToMarkerId(icon: string): string {
  const pri = /^priority_([1-9]|10)$/.exec(icon)
  if (pri) return `priority-${pri[1]}`
  return icon
}

export function markersToIcons(markers: any[] | undefined): string[] {
  const out: string[] = []
  for (const m of markers || []) {
    const icon = m?.markerId ? markerToIcon(String(m.markerId)) : null
    if (icon) out.push(icon)
  }
  return out
}

const isHttpLink = (s: string) => /^https?:\/\//i.test(s)

// ---- 解析:XMind Zen / 2020+ (content.json) ----

export function topicToNode(t: any, res?: XmindResources): any {
  const data: any = { text: t?.title || '', ...(t?.id ? { uid: t.id } : {}) }

  const note = t?.notes?.plain?.content
  if (typeof note === 'string' && note) data.note = note

  // 只把 http(s) 链接暴露为可点击超链接;xap:attachments/ 等内部引用不展示(保存时原样保留)
  if (typeof t?.href === 'string' && isHttpLink(t.href)) data.hyperlink = t.href

  const imgSrc = typeof t?.image === 'string' ? t.image : t?.image?.src
  if (typeof imgSrc === 'string' && imgSrc) {
    const dataUrl = imgSrc.startsWith('data:') ? imgSrc : resolveResource(imgSrc, res)
    if (dataUrl) {
      data.image = dataUrl
      data.imageTitle = t?.image?.title || ''
      data.imageSize = {
        width: t?.image?.width || 100,
        height: t?.image?.height || t?.image?.width || 100,
      }
    }
  }

  const icons = markersToIcons(t?.markers)
  if (icons.length) data.icon = icons

  return {
    data,
    children: (t?.children?.attached || []).map((c: any) => topicToNode(c, res)),
  }
}

export function parseZen(json: any, res?: XmindResources): XmindSheet[] {
  const sheets = Array.isArray(json) ? json : [json]
  // 不过滤空画布:保存时按下标与原始 JSON 一一对应
  return sheets.map((s: any, i: number) => ({
    name: s?.title || `画布 ${i + 1}`,
    root: s?.rootTopic ? topicToNode(s.rootTopic, res) : { data: { text: s?.title || '主题' }, children: [] },
  }))
}

// ---- 解析:XMind 8 (content.xml) ----

function xmlTopicToNode(el: Element, res?: XmindResources): any {
  const kids = Array.from(el.children)
  const title = kids.find((c) => c.tagName === 'title')?.textContent || ''
  const data: any = { text: title }
  const id = el.getAttribute('id')
  if (id) data.uid = id

  const noteEl = kids.find((c) => c.tagName === 'notes')
  const plain = noteEl && Array.from(noteEl.children).find((c) => c.tagName === 'plain')
  const note = (plain || noteEl)?.textContent?.trim()
  if (note) data.note = note

  const href = el.getAttribute('xlink:href') || el.getAttribute('href')
  if (href && isHttpLink(href)) data.hyperlink = href

  const markerRefs = kids.find((c) => c.tagName === 'marker-refs')
  if (markerRefs) {
    const icons = markersToIcons(
      Array.from(markerRefs.children).map((m) => ({ markerId: m.getAttribute('marker-id') || '' }))
    )
    if (icons.length) data.icon = icons
  }

  const imgEl = kids.find((c) => c.tagName === 'xhtml:img' || c.tagName === 'img')
  if (imgEl) {
    const src = imgEl.getAttribute('xhtml:src') || imgEl.getAttribute('src')
    const dataUrl = src ? (src.startsWith('data:') ? src : resolveResource(src, res)) : null
    if (dataUrl) {
      data.image = dataUrl
      data.imageSize = {
        width: parseInt(imgEl.getAttribute('svg:width') || imgEl.getAttribute('width') || '', 10) || 100,
        height: parseInt(imgEl.getAttribute('svg:height') || imgEl.getAttribute('height') || '', 10) || 100,
      }
    }
  }

  const childrenEl = kids.find((c) => c.tagName === 'children')
  const topics: Element[] = []
  if (childrenEl) {
    for (const ts of Array.from(childrenEl.children)) {
      if (ts.tagName === 'topics' && ts.getAttribute('type') === 'attached') {
        topics.push(...Array.from(ts.children).filter((c) => c.tagName === 'topic'))
      }
    }
  }
  return { data, children: topics.map((t) => xmlTopicToNode(t, res)) }
}

export function parseXml(xml: string, res?: XmindResources): XmindSheet[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  return Array.from(doc.getElementsByTagName('sheet')).map((s, i) => {
    const topic = Array.from(s.children).find((c) => c.tagName === 'topic')
    const title = Array.from(s.children).find((c) => c.tagName === 'title')?.textContent
    return {
      name: title || `画布 ${i + 1}`,
      root: topic ? xmlTopicToNode(topic, res) : { data: { text: '(空画布)' }, children: [] },
    }
  })
}

// ---- 保存:渲染树 → XMind Zen 结构 ----

const genId = (): string =>
  (globalThis.crypto?.randomUUID?.() as string | undefined) ?? Math.random().toString(36).slice(2)

// 内容哈希(djb2 → base36):新图片资源按内容命名,天然去重
function contentHash(str: string): string {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

// 保存上下文:携带解析期资源映射,收集保存期新增的图片资源
export interface SaveContext {
  res: XmindResources
  // 新增资源:zip 内路径 → base64(不含 data: 前缀)
  newResources: Map<string, string>
}

export function createSaveContext(res?: XmindResources): SaveContext {
  return { res: res ?? emptyResources(), newResources: new Map() }
}

function walkTopics(t: any, map: Map<string, any>) {
  if (!t) return
  if (t.id) map.set(t.id, t)
  for (const c of t.children?.attached || []) walkTopics(c, map)
}

// 原始 JSON 中所有 topic 按 id 索引,供保存时按 uid 找回
export function buildTopicIndex(json: any): Map<string, any> {
  const map = new Map<string, any>()
  for (const s of Array.isArray(json) ? json : [json]) walkTopics(s?.rootTopic, map)
  return map
}

const sameIcons = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i])

// 把 dataURL 图片落为 zip 资源引用;已存在的资源(解析映射或本次保存已写入)直接复用
function imageSrcFor(dataUrl: string, ctx: SaveContext): string {
  const known = ctx.res.xapByDataUrl.get(dataUrl)
  if (known) return known
  const m = /^data:image\/([\w+.-]+);base64,(.*)$/s.exec(dataUrl)
  if (!m) return dataUrl // 非 dataURL(如 http 图片)原样写入
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1] === 'svg+xml' ? 'svg' : m[1]
  const path = `resources/img_${contentHash(m[2])}.${ext}`
  ctx.newResources.set(path, m[2])
  const xap = `xap:${path}`
  ctx.res.xapByDataUrl.set(dataUrl, xap)
  return xap
}

// 合并单个节点。原则:与解析时暴露的值比较,未变更的字段保持原 topic 原样
// (保住备注的 html 变体、无法映射的 markers、非 http 的 href、原图片对象等)。
export function nodeToTopic(n: any, ctx?: SaveContext, index?: Map<string, any>): any {
  const orig = n?.data?.uid ? index?.get(n.data.uid) : undefined
  const topic: any = orig ? { ...orig } : { class: 'topic' }
  if (!topic.id) topic.id = genId()
  topic.title = n?.data?.text || ''
  const d = n?.data || {}

  // 备注:未变更保持原 notes(含 html 等变体);变更则以 plain 覆盖;清空则删除
  const surfacedNote = typeof orig?.notes?.plain?.content === 'string' ? orig.notes.plain.content : ''
  const curNote = typeof d.note === 'string' ? d.note : ''
  if (curNote !== surfacedNote) {
    if (curNote) topic.notes = { plain: { content: curNote } }
    else delete topic.notes
  }

  // 超链接:仅与解析暴露的 http(s) 链接比较;xap: 等内部 href 在未主动改链时不受影响
  const surfacedHref = typeof orig?.href === 'string' && isHttpLink(orig.href) ? orig.href : ''
  const curHref = typeof d.hyperlink === 'string' ? d.hyperlink : ''
  if (curHref !== surfacedHref) {
    if (curHref) topic.href = curHref
    else delete topic.href
  }

  // 图片:与解析时实际展示出的 dataURL 比较——
  // 未展示过的原图(资源缺失/未传映射)不动;展示过且被清空才真删;本体未变仅同步尺寸;新图落为资源引用
  const origSrc = orig?.image ? (typeof orig.image === 'string' ? orig.image : orig.image.src) : ''
  const origShown = origSrc
    ? origSrc.startsWith('data:') ? origSrc : resolveResource(origSrc, ctx?.res)
    : null
  const curImage = typeof d.image === 'string' ? d.image : ''
  const w = d.imageSize?.width
  const h = d.imageSize?.height
  if (!curImage) {
    if (origShown) delete topic.image
  } else if (curImage === origShown) {
    const oi = typeof orig.image === 'string' ? { src: orig.image } : orig.image
    const parsedW = oi.width || 100
    const parsedH = oi.height || oi.width || 100
    if (w && h && (w !== parsedW || h !== parsedH)) {
      topic.image = { ...oi, width: w, height: h }
    } // 尺寸未变:topic.image 已随浅拷贝保留原对象
  } else {
    const src = ctx ? imageSrcFor(curImage, ctx) : curImage
    topic.image = { src, ...(w && h ? { width: w, height: h } : {}) }
    if (d.imageTitle) topic.image.title = d.imageTitle
  }

  // 图标:与解析暴露的 icon 序列比较;变更时保留无法映射的原 markers,再追加当前 icon
  const surfacedIcons = markersToIcons(orig?.markers)
  const curIcons: string[] = Array.isArray(d.icon) ? d.icon.filter((x: any) => typeof x === 'string') : []
  if (!sameIcons(curIcons, surfacedIcons)) {
    const kept = (orig?.markers || []).filter((m: any) => !markerToIcon(String(m?.markerId || '')))
    const added = curIcons.map((icon) => ({ markerId: iconToMarkerId(icon) }))
    const markers = [...kept, ...added]
    if (markers.length) topic.markers = markers
    else delete topic.markers
  }

  const attached = (n?.children || []).map((c: any) => nodeToTopic(c, ctx, index))
  if (orig && orig.children && typeof orig.children === 'object' && !Array.isArray(orig.children)) {
    // 保留 children 里 attached 之外的键(summary/detached 等)
    topic.children = { ...orig.children }
    if (attached.length) topic.children.attached = attached
    else delete topic.children.attached
    if (Object.keys(topic.children).length === 0) delete topic.children
  } else if (attached.length) {
    topic.children = { attached }
  } else {
    delete topic.children
  }
  return topic
}

// 构造保存用 content.json:
// - Zen 来源:在原始 JSON 上就地替换各画布 rootTopic(sheet 级字段与节点级富属性都保留)
// - XMind 8 来源:生成全新 Zen 结构
export function buildContentJson(originalZen: any, sheets: XmindSheet[], ctx?: SaveContext): any {
  if (originalZen) {
    const arr = Array.isArray(originalZen) ? originalZen : [originalZen]
    const index = buildTopicIndex(arr)
    arr.forEach((s: any, i: number) => {
      if (sheets[i]) s.rootTopic = nodeToTopic(sheets[i].root, ctx, index)
    })
    return originalZen
  }
  return sheets.map((s) => ({ id: genId(), class: 'sheet', title: s.name, rootTopic: nodeToTopic(s.root, ctx) }))
}

// 组装保存 zip:Zen 来源基于原 zip 覆盖 content.json(保留资源/元数据等其他条目);
// 新包补 metadata/manifest;写入本次新增图片资源;回收 content.json 中不再引用的 resources/ 文件;
// 缩略图有值才写入(调用方负责降采样与大小上限)
export function assembleXmindZip(
  originalZip: JSZip | null,
  json: any,
  thumbPng?: Uint8Array | null,
  ctx?: SaveContext
): JSZip {
  const zip = originalZip ?? new JSZip()
  zip.file('content.json', JSON.stringify(json))
  if (!originalZip) {
    zip.file('metadata.json', JSON.stringify({ creator: { name: 'cfnote' } }))
    zip.file('manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }))
  }
  if (ctx) {
    for (const [path, base64] of ctx.newResources) zip.file(path, base64, { base64: true })
    // GC:content.json 全文未出现的 resources/ 条目视为孤儿删除(按整串扫描,主题/样式引用也算数)
    const text = JSON.stringify(json)
    const toRemove: string[] = []
    zip.forEach((path, file) => {
      if (file.dir || !path.startsWith('resources/')) return
      if (!text.includes(path)) toRemove.push(path)
    })
    for (const path of toRemove) zip.remove(path)
  }
  if (thumbPng) zip.file('Thumbnails/thumbnail.png', thumbPng)
  return zip
}
