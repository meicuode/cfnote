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

  it('xmind 链接按普通链接往返不丢(P6.3 前的形态);中文 URL 规范化为百分号编码但语义等价', () => {
    const md = '[📎 计划.xmind](/api/files/u1/k/计划.xmind)'
    const out = roundtrip(md)
    expect(out).toContain('[📎 计划.xmind](')
    const href = /\]\(([^)]+)\)/.exec(out)![1]
    expect(decodeURIComponent(href)).toBe('/api/files/u1/k/计划.xmind')
    expect(roundtrip(out)).toBe(out)
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
