// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { buildExtensions } from '../src/lib/wysiwygExtensions'

// P6.1 验收:每种标准语法在「Markdown → 编辑器 → Markdown」往返中稳定。
// - 规范风格文档:一次往返后字节级等价(证明打开→编辑→保存不产生无谓 diff)
// - 任意风格文档:二次往返幂等(第一次可能规范化,之后必须稳定)

const roundtrip = (md: string): string => {
  const editor = new Editor({ extensions: buildExtensions(), content: md })
  const out = (editor.storage as any).markdown.getMarkdown()
  editor.destroy()
  return out
}

// 与 tiptap-markdown 序列化风格一致的规范文档(- 列表 / ** 加粗 / * 斜体 / --- 分割线)
const CANONICAL = `# 一级标题

## 二级标题

### 三级标题

普通段落,含**加粗**、*斜体*、~~删除线~~、\`行内代码\`和[链接](https://example.com)。

> 引用一行
> 引用两行

- 无序一
- 无序二
  - 嵌套项

1. 有序一
2. 有序二

\`\`\`ts
const a = 1
\`\`\`

| 表头A | 表头B |
| --- | --- |
| 甲 | 乙 |
| 丙 | 丁 |

---

![截图](/api/files/u1/abc/a.png)

<img src="/api/files/u1/abc/b.png" alt="限宽图" width="300">

结尾段落。`

describe('WYSIWYG 往返(P6.1 验收)', () => {
  it('规范风格文档:一次往返字节级等价', () => {
    expect(roundtrip(CANONICAL)).toBe(CANONICAL)
  })

  it('任意风格文档:二次往返幂等,语义构造全保留', () => {
    const messy = [
      '#   空格随意的标题',
      '',
      '* 星号列表',
      '* 第二项',
      '',
      '__下划线加粗__ 和 _下划线斜体_',
      '',
      '***',
    ].join('\n')
    const once = roundtrip(messy)
    const twice = roundtrip(once)
    expect(twice).toBe(once)
    expect(once).toContain('# 空格随意的标题')
    expect(once).toContain('- 星号列表')
    expect(once).toContain('**下划线加粗**')
    expect(once).toContain('*下划线斜体*')
    expect(once).toContain('---')
  })

  it('单换行(breaks 语义)在往返中保留', () => {
    const md = '第一行\n第二行'
    const out = roundtrip(md)
    expect(roundtrip(out)).toBe(out)
    expect(out).toContain('第一行')
    expect(out).toContain('第二行')
    expect(out).not.toContain('第一行第二行')
  })

  it('img width 往返保留(标准内嵌 HTML),无尺寸图片保持 md 形式', () => {
    const out = roundtrip('前文\n\n<img src="/x.png" alt="图" width="240">\n\n![普通](/y.png)')
    expect(out).toContain('<img src="/x.png" alt="图" width="240">')
    expect(out).toContain('![普通](/y.png)')
  })

  // P6.3:.xmind 链接解析为 xmindCard 原子节点(编辑器内不实例化思维导图引擎,卡片只是缩略图),
  // 序列化写回标准 MD 链接 [显示名](url)
  it('xmind 链接解析为卡片节点,已编码 URL 字节级往返;中文 URL 语义等价', () => {
    const encoded = '[📎 计划.xmind](/api/files/u1/k/%E8%AE%A1%E5%88%92.xmind)'
    const ed = new Editor({ extensions: buildExtensions(), content: encoded })
    const cards: any[] = []
    ed.state.doc.descendants((n) => {
      if (n.type.name === 'xmindCard') cards.push(n)
      return true
    })
    expect(cards.length).toBe(1)
    expect(cards[0].attrs.label).toBe('📎 计划.xmind')
    expect((ed.storage as any).markdown.getMarkdown()).toBe(encoded)
    ed.destroy()

    const raw = roundtrip('[📎 计划.xmind](/api/files/u1/k/计划.xmind)')
    const href = /\]\(([^)]+)\)/.exec(raw)![1]
    expect(decodeURIComponent(href)).toBe('/api/files/u1/k/计划.xmind')
    expect(roundtrip(raw)).toBe(raw)
  })

  it('改名产物为 [新名](原url);删除卡片=删除链接;非 xmind 附件不卡片化', () => {
    const ed = new Editor({ extensions: buildExtensions(), content: '[旧名](/api/files/u1/k/a.xmind)' })
    let pos = -1
    let card: any = null
    ed.state.doc.descendants((n, p) => {
      if (pos >= 0) return false
      if (n.type.name === 'xmindCard') {
        pos = p
        card = n
        return false
      }
      return true
    })
    expect(pos).toBeGreaterThanOrEqual(0)
    ed.view.dispatch(ed.view.state.tr.setNodeMarkup(pos, undefined, { ...card.attrs, label: '2026 规划' }))
    expect((ed.storage as any).markdown.getMarkdown()).toBe('[2026 规划](/api/files/u1/k/a.xmind)')
    ed.view.dispatch(ed.view.state.tr.delete(pos, pos + 1))
    expect((ed.storage as any).markdown.getMarkdown()).not.toContain('a.xmind')
    ed.destroy()

    const pdf = '[📎 报告.pdf](/api/files/u1/k/report.pdf)'
    const ed2 = new Editor({ extensions: buildExtensions(), content: pdf })
    let hasCard = false
    ed2.state.doc.descendants((n) => {
      if (n.type.name === 'xmindCard') hasCard = true
      return true
    })
    ed2.destroy()
    expect(hasCard).toBe(false)
    expect(roundtrip(pdf)).toBe(pdf)
  })

  it('多卡片渲染为缩略图卡片 DOM(jsdom 冒烟)', () => {
    const ed = new Editor({
      extensions: buildExtensions(),
      content: '[a](/f/x.xmind)\n\n[b](/f/y.xmind)\n\n[c](/f/z.xmind)',
    })
    expect(ed.view.dom.querySelectorAll('a.cfnote-xmind-card').length).toBe(3)
    expect(ed.view.dom.querySelectorAll('.cfnote-xmind-rename').length).toBe(3)
    ed.destroy()
  })

  // P6.2:拖拽调宽在 mouseup 时对图片节点 setNodeMarkup({width, height: null}),
  // 序列化产物必须是标准内嵌 HTML <img width>(与预览模式拖拽调宽的产物一致)
  it('调宽产物:设 width 清 height 后序列化为标准 <img width>', () => {
    const editor = new Editor({
      extensions: buildExtensions(),
      content: '![截图](/a.png)\n\n<img src="/b.png" alt="乙" width="500" height="400">',
    })
    const setWidth = (src: string, width: number) => {
      const { state } = editor.view
      let pos = -1
      let attrs: Record<string, unknown> = {}
      state.doc.descendants((n, p) => {
        if (pos >= 0) return false
        if (n.type.name === 'image' && n.attrs.src === src) {
          pos = p
          attrs = n.attrs
          return false
        }
        return true
      })
      expect(pos).toBeGreaterThanOrEqual(0)
      editor.view.dispatch(state.tr.setNodeMarkup(pos, undefined, { ...attrs, width, height: null }))
    }
    setWidth('/a.png', 300)
    setWidth('/b.png', 260)
    const out = (editor.storage as any).markdown.getMarkdown()
    editor.destroy()
    expect(out).toContain('<img src="/a.png" alt="截图" width="300">')
    expect(out).toContain('<img src="/b.png" alt="乙" width="260">')
    expect(out).not.toContain('height')
  })

  it('图片 NodeView 渲染出调宽手柄(jsdom 冒烟)', () => {
    const editor = new Editor({ extensions: buildExtensions(), content: '![截图](/a.png)' })
    const handles = editor.view.dom.querySelectorAll('.cfnote-img-wrap .cfnote-img-handle')
    expect(handles.length).toBe(1)
    editor.destroy()
  })
})
