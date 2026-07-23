import JSZip from 'jszip'

// XMind 文件的解析与保存纯逻辑(与 UI 解耦,tests/xmind.test.ts 覆盖):
// - 解析:Zen/2020+ 的 content.json 与 XMind 8 的 content.xml → 渲染树
// - 保存:渲染树 → content.json。通过 data.uid 找回原始 topic,浅拷贝保留节点级富属性
//   (备注/图片/标记/超链接/样式/summary 等),仅更新标题与子节点结构,防止保存丢数据
// - 组装 zip:Zen 来源基于原 zip 覆盖(保留资源等其他条目),控制体积只增不炸

export interface XmindSheet {
  name: string
  root: any
}

// ---- 解析:XMind Zen / 2020+ (content.json) ----

export function topicToNode(t: any): any {
  return {
    data: { text: t?.title || '', ...(t?.id ? { uid: t.id } : {}) },
    children: (t?.children?.attached || []).map(topicToNode),
  }
}

export function parseZen(json: any): XmindSheet[] {
  const sheets = Array.isArray(json) ? json : [json]
  // 不过滤空画布:保存时按下标与原始 JSON 一一对应
  return sheets.map((s: any, i: number) => ({
    name: s?.title || `画布 ${i + 1}`,
    root: s?.rootTopic ? topicToNode(s.rootTopic) : { data: { text: s?.title || '主题' }, children: [] },
  }))
}

// ---- 解析:XMind 8 (content.xml) ----

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

export function parseXml(xml: string): XmindSheet[] {
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

// ---- 保存:渲染树 → XMind Zen 结构 ----

const genId = (): string =>
  (globalThis.crypto?.randomUUID?.() as string | undefined) ?? Math.random().toString(36).slice(2)

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

export function nodeToTopic(n: any, index?: Map<string, any>): any {
  const orig = n?.data?.uid ? index?.get(n.data.uid) : undefined
  const topic: any = orig ? { ...orig } : { class: 'topic' }
  if (!topic.id) topic.id = genId()
  topic.title = n?.data?.text || ''

  const attached = (n?.children || []).map((c: any) => nodeToTopic(c, index))
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
export function buildContentJson(originalZen: any, sheets: XmindSheet[]): any {
  if (originalZen) {
    const arr = Array.isArray(originalZen) ? originalZen : [originalZen]
    const index = buildTopicIndex(arr)
    arr.forEach((s: any, i: number) => {
      if (sheets[i]) s.rootTopic = nodeToTopic(sheets[i].root, index)
    })
    return originalZen
  }
  return sheets.map((s) => ({ id: genId(), class: 'sheet', title: s.name, rootTopic: nodeToTopic(s.root) }))
}

// 组装保存 zip:Zen 来源基于原 zip 覆盖 content.json(保留资源/元数据等其他条目);
// 新包补 metadata/manifest;缩略图有值才写入(调用方负责降采样与大小上限)
export function assembleXmindZip(originalZip: JSZip | null, json: any, thumbPng?: Uint8Array | null): JSZip {
  const zip = originalZip ?? new JSZip()
  zip.file('content.json', JSON.stringify(json))
  if (!originalZip) {
    zip.file('metadata.json', JSON.stringify({ creator: { name: 'cfnote' } }))
    zip.file('manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {} } }))
  }
  if (thumbPng) zip.file('Thumbnails/thumbnail.png', thumbPng)
  return zip
}
