// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  parseZen, parseXml, buildContentJson, assembleXmindZip, buildTopicIndex, nodeToTopic,
  extractResources, emptyResources, createSaveContext, markerToIcon, iconToMarkerId, markersToIcons,
} from '../src/lib/xmind'
import { THUMB_MAX_BYTES } from '../src/lib/thumbnail'

// 含节点级富属性(备注/图片/标记/超链接/样式/summary)与多画布的 Zen 结构
const makeZen = () => ([
  {
    id: 's1', class: 'sheet', title: 'Sheet A', theme: { map: { fill: '#fff' } },
    rootTopic: {
      id: 'r1', class: 'topic', title: 'Root', style: { color: '#ff0000' },
      // html 变体在备注未变更时必须原样保留
      notes: { plain: { content: 'root note' }, html: { content: { paragraphs: [] } } },
      children: {
        attached: [
          {
            id: 'c1', title: 'Child 1',
            markers: [{ markerId: 'priority-1' }],
            image: { src: 'xap:resources/img1.png', width: 100 },
          },
          {
            id: 'c2', title: 'Child 2', href: 'https://example.com',
            children: {
              attached: [{ id: 'g1', title: 'Grand' }],
              summary: [{ id: 'sum1', title: '概要' }],
            },
          },
        ],
      },
    },
  },
  {
    id: 's2', class: 'sheet', title: 'Sheet B',
    // style 里的资源引用不能被 GC 误删
    style: { background: 'xap:resources/keep.png' },
    rootTopic: {
      id: 'r2', title: 'B root', notes: { plain: { content: 'keep me' } },
      children: {
        attached: [
          // flag-red 无法映射为 smm 图标,href 非 http:都不展示但保存必须保留
          { id: 'b1', title: 'B1', markers: [{ markerId: 'flag-red' }], href: 'xap:attachments/file.pdf' },
        ],
      },
    },
  },
])

const IMG1_BYTES = new Uint8Array(5 * 1024).fill(7)
const IMG1_B64 = Buffer.from(IMG1_BYTES).toString('base64')
const IMG1_DATAURL = `data:image/png;base64,${IMG1_B64}`

// 手工构造资源映射(等价于 extractResources 对 fixture zip 的输出)
const makeRes = () => {
  const res = emptyResources()
  res.byPath.set('resources/img1.png', IMG1_DATAURL)
  res.xapByDataUrl.set(IMG1_DATAURL, 'xap:resources/img1.png')
  return res
}

describe('markers ↔ icon 映射', () => {
  it('priority 双向精确互转,smm 独有分组透传,其余不映射', () => {
    expect(markerToIcon('priority-1')).toBe('priority_1')
    expect(markerToIcon('priority-10')).toBe('priority_10')
    expect(markerToIcon('priority-11')).toBeNull()
    expect(markerToIcon('progress_3')).toBe('progress_3')
    expect(markerToIcon('task-start')).toBeNull()
    expect(markerToIcon('flag-red')).toBeNull()
    expect(iconToMarkerId('priority_2')).toBe('priority-2')
    expect(iconToMarkerId('expression_5')).toBe('expression_5')
    expect(markersToIcons([{ markerId: 'priority-1' }, { markerId: 'flag-red' }, { markerId: 'sign_1' }]))
      .toEqual(['priority_1', 'sign_1'])
  })
})

describe('parseZen', () => {
  it('解析多画布结构,节点带 uid 与层级', () => {
    const sheets = parseZen(makeZen())
    expect(sheets).toHaveLength(2)
    expect(sheets[0].name).toBe('Sheet A')
    expect(sheets[0].root.data).toEqual({ text: 'Root', uid: 'r1', note: 'root note' })
    expect(sheets[0].root.children.map((c: any) => c.data.text)).toEqual(['Child 1', 'Child 2'])
    expect(sheets[0].root.children[1].children[0].data).toEqual({ text: 'Grand', uid: 'g1' })
    expect(sheets[1].root.children[0].data.uid).toBe('b1')
  })

  it('富属性映射:备注/超链接/标记;未传资源映射时图片不展示', () => {
    const sheets = parseZen(makeZen())
    const [a, b] = sheets
    expect(a.root.data.note).toBe('root note')
    expect(a.root.children[0].data.icon).toEqual(['priority_1'])
    expect(a.root.children[0].data.image).toBeUndefined()
    expect(a.root.children[1].data.hyperlink).toBe('https://example.com')
    // flag-red 不映射,xap: 链接不展示
    expect(b.root.children[0].data.icon).toBeUndefined()
    expect(b.root.children[0].data.hyperlink).toBeUndefined()
  })

  it('传入资源映射时图片解析为 dataURL 并带尺寸(缺 height 用 width 兜底)', () => {
    const sheets = parseZen(makeZen(), makeRes())
    const c1 = sheets[0].root.children[0].data
    expect(c1.image).toBe(IMG1_DATAURL)
    expect(c1.imageSize).toEqual({ width: 100, height: 100 })
  })
})

describe('extractResources', () => {
  it('提取 resources/ 与 attachments/ 下的图片为 dataURL,建立双向映射', async () => {
    const zip = new JSZip()
    zip.file('content.json', '[]')
    zip.file('resources/img1.png', IMG1_BYTES)
    zip.file('attachments/a.jpg', new Uint8Array(16).fill(1))
    zip.file('resources/readme.txt', 'not an image')
    const res = await extractResources(zip)
    expect(res.byPath.get('resources/img1.png')).toBe(IMG1_DATAURL)
    expect(res.byPath.get('attachments/a.jpg')!.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(res.byPath.has('resources/readme.txt')).toBe(false)
    expect(res.xapByDataUrl.get(IMG1_DATAURL)).toBe('xap:resources/img1.png')
  })
})

describe('buildContentJson(保存)', () => {
  it('未做任何编辑时保存是无损的(深度相等,不传资源映射)', () => {
    const zen = makeZen()
    const json = buildContentJson(zen, parseZen(zen))
    expect(json).toEqual(makeZen())
  })

  it('未做任何编辑时保存是无损的(传资源映射,图片已展示)', () => {
    const zen = makeZen()
    const res = makeRes()
    const json = buildContentJson(zen, parseZen(zen, res), createSaveContext(res))
    expect(json).toEqual(makeZen())
  })

  it('改标题/增删节点后:被改节点富属性保留,未动画布逐字段不变', () => {
    const zen = makeZen()
    const sheets = parseZen(zen)
    // 编辑画布 A:c1 改名、root 下新增节点、删除 g1
    sheets[0].root.children[0].data.text = 'Child 1 renamed'
    sheets[0].root.children.push({ data: { text: 'New node' }, children: [] })
    sheets[0].root.children[1].children = []

    const json = buildContentJson(zen, sheets)
    const [a, b] = json

    // c1:标题更新,markers/image 原样保留,id 不变
    const c1 = a.rootTopic.children.attached[0]
    expect(c1.title).toBe('Child 1 renamed')
    expect(c1.id).toBe('c1')
    expect(c1.markers).toEqual([{ markerId: 'priority-1' }])
    expect(c1.image).toEqual({ src: 'xap:resources/img1.png', width: 100 })

    // root:备注(含 html 变体)与样式保留
    expect(a.rootTopic.notes).toEqual({ plain: { content: 'root note' }, html: { content: { paragraphs: [] } } })
    expect(a.rootTopic.style).toEqual({ color: '#ff0000' })

    // c2:g1 已删除,children.summary 等非 attached 键保留,href 保留
    const c2 = a.rootTopic.children.attached[1]
    expect(c2.href).toBe('https://example.com')
    expect(c2.children.attached).toBeUndefined()
    expect(c2.children.summary).toEqual([{ id: 'sum1', title: '概要' }])

    // 新节点:有生成的 id 和 class
    const fresh = a.rootTopic.children.attached[2]
    expect(fresh.title).toBe('New node')
    expect(fresh.class).toBe('topic')
    expect(typeof fresh.id).toBe('string')
    expect(fresh.id.length).toBeGreaterThan(0)

    // 画布 B 完全未受影响
    expect(b).toEqual(makeZen()[1])
    // sheet 级字段保留
    expect(a.theme).toEqual({ map: { fill: '#fff' } })
  })

  it('备注编辑:修改以 plain 覆盖(html 变体随之作废),清空则删除,未动画布不受影响', () => {
    const zen = makeZen()
    const sheets = parseZen(zen)
    sheets[0].root.children[0].data.note = 'note on c1'
    sheets[0].root.data.note = '' // 清空 root 备注

    const [a, b] = buildContentJson(zen, sheets)
    expect(a.rootTopic.children.attached[0].notes).toEqual({ plain: { content: 'note on c1' } })
    expect(a.rootTopic.notes).toBeUndefined()
    expect(b.rootTopic.notes).toEqual({ plain: { content: 'keep me' } })
  })

  it('超链接编辑:新增/清空 http 链接;非 http 的原 href 被主动设置链接时才覆盖', () => {
    const zen = makeZen()
    const sheets = parseZen(zen)
    sheets[0].root.children[1].children = [] // 删掉 g1 便于定位
    sheets[0].root.children[1].data.hyperlink = '' // 清空 c2 链接
    sheets[0].root.children[0].data.hyperlink = 'https://cf.note/' // c1 加链接
    sheets[1].root.children[0].data.hyperlink = 'https://override.example' // b1 覆盖 xap 附件引用

    const [a, b] = buildContentJson(zen, sheets)
    expect(a.rootTopic.children.attached[1].href).toBeUndefined()
    expect(a.rootTopic.children.attached[0].href).toBe('https://cf.note/')
    expect(b.rootTopic.children.attached[0].href).toBe('https://override.example')
  })

  it('图标编辑:priority 写回 XMind 原生 id,无法映射的原 markers 保留,清空只清可映射部分', () => {
    const zen = makeZen()
    const sheets = parseZen(zen)
    sheets[0].root.children[0].data.icon = ['priority_2', 'sign_1'] // c1 换图标
    sheets[1].root.children[0].data.icon = ['priority_1'] // b1(含 flag-red)加图标

    const [a, b] = buildContentJson(zen, sheets)
    expect(a.rootTopic.children.attached[0].markers).toEqual([{ markerId: 'priority-2' }, { markerId: 'sign_1' }])
    expect(b.rootTopic.children.attached[0].markers).toEqual([{ markerId: 'flag-red' }, { markerId: 'priority-1' }])

    // 清空 c1 图标:markers 整体删除(原 markers 全部可映射)
    const zen2 = makeZen()
    const sheets2 = parseZen(zen2)
    sheets2[0].root.children[0].data.icon = []
    const [a2] = buildContentJson(zen2, sheets2)
    expect(a2.rootTopic.children.attached[0].markers).toBeUndefined()
  })

  it('图片编辑:新图落为内容哈希资源引用并去重,删除图片移除 image,仅改尺寸只更新宽高', () => {
    const zen = makeZen()
    const res = makeRes()
    const ctx = createSaveContext(res)
    const sheets = parseZen(zen, res)
    const newDataUrl = 'data:image/png;base64,' + Buffer.from(new Uint8Array(64).fill(3)).toString('base64')
    // g1 和 b1 插入同一张新图 → 资源只写一份
    sheets[0].root.children[1].children[0].data.image = newDataUrl
    sheets[0].root.children[1].children[0].data.imageSize = { width: 50, height: 40 }
    sheets[1].root.children[0].data.image = newDataUrl
    sheets[1].root.children[0].data.imageSize = { width: 50, height: 40 }
    // c1 仅调整尺寸(图片本体未变)
    sheets[0].root.children[0].data.imageSize = { width: 200, height: 150 }

    const [a, b] = buildContentJson(zen, sheets, ctx)

    expect(ctx.newResources.size).toBe(1)
    const [path] = [...ctx.newResources.keys()]
    expect(path).toMatch(/^resources\/img_[a-z0-9]+\.png$/)
    const g1 = a.rootTopic.children.attached[1].children.attached[0]
    expect(g1.image).toEqual({ src: `xap:${path}`, width: 50, height: 40 })
    expect(b.rootTopic.children.attached[0].image).toEqual({ src: `xap:${path}`, width: 50, height: 40 })
    expect(a.rootTopic.children.attached[0].image).toEqual({ src: 'xap:resources/img1.png', width: 200, height: 150 })

    // 删除 c1 图片
    const zen2 = makeZen()
    const res2 = makeRes()
    const sheets2 = parseZen(zen2, res2)
    sheets2[0].root.children[0].data.image = ''
    const [a2] = buildContentJson(zen2, sheets2, createSaveContext(res2))
    expect(a2.rootTopic.children.attached[0].image).toBeUndefined()
  })

  it('资源映射缺失(图片未展示过)时,清空 image 字段不会误删原图', () => {
    const zen = makeZen()
    const sheets = parseZen(zen) // 不传 res → c1 图片未展示,data.image 为空
    const [a] = buildContentJson(zen, sheets, createSaveContext())
    expect(a.rootTopic.children.attached[0].image).toEqual({ src: 'xap:resources/img1.png', width: 100 })
  })

  it('XMind 8 来源(无原始 JSON)生成合法的全新 Zen 结构', () => {
    const xml = `<?xml version="1.0"?>
      <xmap-content><sheet><title>旧格式</title>
        <topic><title>中心</title>
          <children><topics type="attached">
            <topic><title>甲</title></topic>
            <topic><title>乙</title></topic>
          </topics></children>
        </topic>
      </sheet></xmap-content>`
    const sheets = parseXml(xml)
    expect(sheets[0].name).toBe('旧格式')
    expect(sheets[0].root.data.text).toBe('中心')
    expect(sheets[0].root.children.map((c: any) => c.data.text)).toEqual(['甲', '乙'])

    const json = buildContentJson(null, sheets)
    expect(json).toHaveLength(1)
    expect(json[0].class).toBe('sheet')
    expect(typeof json[0].id).toBe('string')
    expect(json[0].rootTopic.title).toBe('中心')
    expect(json[0].rootTopic.children.attached).toHaveLength(2)
  })

  it('XMind 8 富属性解析:备注/标记/链接/图片(经资源映射)', () => {
    const res = emptyResources()
    const picUrl = 'data:image/png;base64,QUJD'
    res.byPath.set('attachments/pic.png', picUrl)
    const xml = `<?xml version="1.0"?>
      <xmap-content xmlns:xlink="http://www.w3.org/1999/xlink"><sheet><title>S</title>
        <topic id="t1" xlink:href="https://old.example">
          <title>中心</title>
          <notes><plain>老备注</plain></notes>
          <marker-refs><marker-ref marker-id="priority-3"/><marker-ref marker-id="flag-red"/></marker-refs>
          <children><topics type="attached">
            <topic id="t2"><title>图</title><img src="xap:attachments/pic.png" width="80" height="60"/></topic>
          </topics></children>
        </topic>
      </sheet></xmap-content>`
    const [s] = parseXml(xml, res)
    expect(s.root.data.note).toBe('老备注')
    expect(s.root.data.hyperlink).toBe('https://old.example')
    expect(s.root.data.icon).toEqual(['priority_3'])
    expect(s.root.children[0].data.image).toBe(picUrl)
    expect(s.root.children[0].data.imageSize).toEqual({ width: 80, height: 60 })

    // 转存为 Zen:富属性写入新结构
    const json = buildContentJson(null, [s], createSaveContext())
    const root = json[0].rootTopic
    expect(root.notes).toEqual({ plain: { content: '老备注' } })
    expect(root.href).toBe('https://old.example')
    expect(root.markers).toEqual([{ markerId: 'priority-3' }])
    expect(root.children.attached[0].image.src).toMatch(/^xap:resources\/img_[a-z0-9]+\.png$/)
  })

  it('nodeToTopic:uid 找不到原节点时按新节点处理', () => {
    const index = buildTopicIndex(makeZen())
    const t = nodeToTopic({ data: { text: 'ghost', uid: 'not-exist' }, children: [] }, undefined, index)
    expect(t.title).toBe('ghost')
    expect(t.id).not.toBe('not-exist')
  })
})

describe('assembleXmindZip(完整性与体积)', () => {
  const buildOriginalZip = async () => {
    const zip = new JSZip()
    zip.file('content.json', JSON.stringify(makeZen()))
    zip.file('metadata.json', JSON.stringify({ creator: { name: 'XMind' } }))
    zip.file('manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {} } }))
    zip.file('resources/img1.png', IMG1_BYTES)
    zip.file('resources/keep.png', new Uint8Array(1024).fill(2))
    zip.file('resources/orphan.png', new Uint8Array(2 * 1024).fill(4))
    zip.file('Thumbnails/thumbnail.png', new Uint8Array(3 * 1024).fill(9))
    return zip
  }

  it('保存后资源/元数据条目保留,content.json 更新,缩略图被替换', async () => {
    const zip = await buildOriginalZip()
    const sheets = parseZen(makeZen())
    sheets[0].root.data.text = 'Root v2'
    const json = buildContentJson(makeZen(), sheets)
    const thumb = new Uint8Array(10 * 1024).fill(3)

    const out = assembleXmindZip(zip, json, thumb)
    const reloaded = await JSZip.loadAsync(await out.generateAsync({ type: 'uint8array' }))

    // 其他条目原样保留
    expect(new Uint8Array(await reloaded.file('resources/img1.png')!.async('arraybuffer')))
      .toEqual(IMG1_BYTES)
    expect(JSON.parse(await reloaded.file('metadata.json')!.async('string'))).toEqual({ creator: { name: 'XMind' } })
    // content.json 是编辑后的
    const content = JSON.parse(await reloaded.file('content.json')!.async('string'))
    expect(content[0].rootTopic.title).toBe('Root v2')
    // 缩略图是新图(10KB),不是旧图(3KB)
    const tb = new Uint8Array(await reloaded.file('Thumbnails/thumbnail.png')!.async('arraybuffer'))
    expect(tb).toEqual(thumb)
  })

  it('无缩略图时保留原缩略图;体积增量受控(< 缩略图大小 + 20KB)', async () => {
    const before = await (await buildOriginalZip()).generateAsync({ type: 'uint8array' })

    // 不传缩略图:原 thumbnail 保留
    const zipA = await buildOriginalZip()
    const outA = assembleXmindZip(zipA, buildContentJson(makeZen(), parseZen(makeZen())), null)
    const reloadedA = await JSZip.loadAsync(await outA.generateAsync({ type: 'uint8array' }))
    expect(new Uint8Array(await reloadedA.file('Thumbnails/thumbnail.png')!.async('arraybuffer')))
      .toEqual(new Uint8Array(3 * 1024).fill(9))

    // 传缩略图:总体积增量 < 缩略图字节数 + 20KB(不会剧烈膨胀)
    const thumb = new Uint8Array(64 * 1024).fill(5)
    const zipB = await buildOriginalZip()
    const outB = assembleXmindZip(zipB, buildContentJson(makeZen(), parseZen(makeZen())), thumb)
    const after = await outB.generateAsync({ type: 'uint8array' })
    expect(after.length - before.length).toBeLessThan(thumb.length + 20 * 1024)
  })

  it('带保存上下文:新图片写入 zip,孤儿资源被回收,引用中的资源保留', async () => {
    const zip = await buildOriginalZip()
    const res = await extractResources(zip)
    const ctx = createSaveContext(res)
    const sheets = parseZen(makeZen(), res)
    const newDataUrl = 'data:image/jpeg;base64,' + Buffer.from(new Uint8Array(256).fill(8)).toString('base64')
    sheets[0].root.children[1].children[0].data.image = newDataUrl
    sheets[0].root.children[1].children[0].data.imageSize = { width: 30, height: 30 }
    const json = buildContentJson(makeZen(), sheets, ctx)

    const out = assembleXmindZip(zip, json, null, ctx)
    const reloaded = await JSZip.loadAsync(await out.generateAsync({ type: 'uint8array' }))

    // 新图片按内容哈希写入且字节正确
    const [newPath] = [...ctx.newResources.keys()]
    expect(newPath).toMatch(/^resources\/img_[a-z0-9]+\.jpg$/)
    expect(new Uint8Array(await reloaded.file(newPath)!.async('arraybuffer')))
      .toEqual(new Uint8Array(256).fill(8))
    // 图片本体未变的 img1 保留;style 引用的 keep 保留;无引用的 orphan 被回收
    expect(reloaded.file('resources/img1.png')).toBeTruthy()
    expect(reloaded.file('resources/keep.png')).toBeTruthy()
    expect(reloaded.file('resources/orphan.png')).toBeNull()
  })

  it('删除节点图片后,对应资源在保存时被回收(体积随之缩小)', async () => {
    const zip = await buildOriginalZip()
    const res = await extractResources(zip)
    const ctx = createSaveContext(res)
    const sheets = parseZen(makeZen(), res)
    sheets[0].root.children[0].data.image = '' // 删除 c1 图片
    const json = buildContentJson(makeZen(), sheets, ctx)

    const out = assembleXmindZip(zip, json, null, ctx)
    const bytes = await out.generateAsync({ type: 'uint8array' })
    const reloaded = await JSZip.loadAsync(bytes)
    expect(reloaded.file('resources/img1.png')).toBeNull()
    expect(reloaded.file('resources/keep.png')).toBeTruthy()

    const baseline = await (await buildOriginalZip()).generateAsync({ type: 'uint8array' })
    expect(bytes.length).toBeLessThan(baseline.length)
  })

  it('新建包(XMind 8 转存)含 metadata/manifest 且可解析', async () => {
    const json = buildContentJson(null, [{ name: 'S', root: { data: { text: 'T' }, children: [] } }])
    const out = assembleXmindZip(null, json, null)
    const reloaded = await JSZip.loadAsync(await out.generateAsync({ type: 'uint8array' }))
    expect(reloaded.file('content.json')).toBeTruthy()
    expect(reloaded.file('metadata.json')).toBeTruthy()
    expect(reloaded.file('manifest.json')).toBeTruthy()
  })

  it('缩略图上限常量存在且为 512KB(组件侧超限即放弃)', () => {
    expect(THUMB_MAX_BYTES).toBe(512 * 1024)
  })
})
