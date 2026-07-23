// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import JSZip from 'jszip'
import {
  parseZen, parseXml, buildContentJson, assembleXmindZip, buildTopicIndex, nodeToTopic,
} from '../src/lib/xmind'
import { THUMB_MAX_BYTES } from '../src/lib/thumbnail'

// 含节点级富属性(备注/图片/标记/超链接/样式/summary)与多画布的 Zen 结构
const makeZen = () => ([
  {
    id: 's1', class: 'sheet', title: 'Sheet A', theme: { map: { fill: '#fff' } },
    rootTopic: {
      id: 'r1', class: 'topic', title: 'Root', style: { color: '#ff0000' },
      notes: { plain: { content: 'root note' } },
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
    rootTopic: {
      id: 'r2', title: 'B root', notes: { plain: { content: 'keep me' } },
      children: { attached: [{ id: 'b1', title: 'B1', markers: [{ markerId: 'flag-red' }] }] },
    },
  },
])

describe('parseZen', () => {
  it('解析多画布结构,节点带 uid 与层级', () => {
    const sheets = parseZen(makeZen())
    expect(sheets).toHaveLength(2)
    expect(sheets[0].name).toBe('Sheet A')
    expect(sheets[0].root.data).toEqual({ text: 'Root', uid: 'r1' })
    expect(sheets[0].root.children.map((c: any) => c.data.text)).toEqual(['Child 1', 'Child 2'])
    expect(sheets[0].root.children[1].children[0].data).toEqual({ text: 'Grand', uid: 'g1' })
    expect(sheets[1].root.children[0].data.uid).toBe('b1')
  })
})

describe('buildContentJson(保存)', () => {
  it('未做任何编辑时保存是无损的(深度相等)', () => {
    const zen = makeZen()
    const json = buildContentJson(zen, parseZen(zen))
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

    // root:备注与样式保留
    expect(a.rootTopic.notes).toEqual({ plain: { content: 'root note' } })
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

  it('nodeToTopic:uid 找不到原节点时按新节点处理', () => {
    const index = buildTopicIndex(makeZen())
    const t = nodeToTopic({ data: { text: 'ghost', uid: 'not-exist' }, children: [] }, index)
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
    zip.file('resources/img1.png', new Uint8Array(5 * 1024).fill(7))
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
      .toEqual(new Uint8Array(5 * 1024).fill(7))
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
