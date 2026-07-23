import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import HardBreak from '@tiptap/extension-hard-break'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from 'tiptap-markdown'

// P6.1 所见即所得编辑器的扩展集(组件与往返测试共用,见 docs/wysiwyg-editor.md)。
// 硬约束:持久化是标准 Markdown;图片尺寸用内嵌 HTML <img width>(CommonMark Raw HTML)。

// 图片:有宽高时序列化为标准 <img>(与预览拖拽调宽的产物一致),无宽高保持 ![alt](src)
// NodeView 提供右下角拖拽调宽手柄(与预览模式同一套 .cfnote-img-wrap/.cfnote-img-handle 样式)
const MdImage = Image.extend({
  addNodeView() {
    return ({ node: initialNode, editor, getPos }) => {
      let node = initialNode
      const wrap = document.createElement('span')
      wrap.className = 'cfnote-img-wrap'
      const img = document.createElement('img')
      const sync = () => {
        if (img.getAttribute('src') !== node.attrs.src) img.setAttribute('src', node.attrs.src || '')
        if (node.attrs.alt) img.setAttribute('alt', node.attrs.alt)
        else img.removeAttribute('alt')
        if (node.attrs.title) img.setAttribute('title', node.attrs.title)
        else img.removeAttribute('title')
        if (node.attrs.width) img.setAttribute('width', String(node.attrs.width))
        else img.removeAttribute('width')
        if (node.attrs.height) img.setAttribute('height', String(node.attrs.height))
        else img.removeAttribute('height')
        // 上传中(blob 预览)半透明提示
        img.style.opacity = String(node.attrs.src || '').startsWith('blob:') ? '0.6' : ''
      }
      sync()
      const handle = document.createElement('b')
      handle.className = 'cfnote-img-handle'
      handle.contentEditable = 'false'
      // appendChild 而非 append:后者与 workers-types 的 HTMLRewriter Element.append 全局类型冲突
      wrap.appendChild(img)
      wrap.appendChild(handle)
      handle.addEventListener('mousedown', (e: MouseEvent) => {
        if (!editor.isEditable) return
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startW = img.getBoundingClientRect().width || Number(node.attrs.width) || 300
        const maxW = Math.round(editor.view.dom.getBoundingClientRect().width) || 1200
        let lastW = Math.round(startW)
        const onMove = (ev: MouseEvent) => {
          lastW = Math.max(80, Math.min(Math.round(startW + (ev.clientX - startX)), maxW))
          img.style.width = `${lastW}px`
        }
        const onUp = () => {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          img.style.width = ''
          const pos = typeof getPos === 'function' ? getPos() : undefined
          if (typeof pos !== 'number') return
          const { state, dispatch } = editor.view
          // 只写 width、清掉 height:等比缩放交给浏览器,序列化产物为 <img width>
          dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: lastW, height: null }))
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })
      return {
        dom: wrap,
        update(n) {
          if (n.type.name !== 'image') return false
          node = n
          sync()
          return true
        },
        // 叶子节点,DOM 完全自管(拖拽中的行内样式等),PM 无需响应内部变更
        ignoreMutation: () => true,
      }
    }
  },
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const { src, alt, title, width, height } = node.attrs
          if (width || height) {
            const esc = (s: unknown) => String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            let tag = `<img src="${esc(src)}"`
            if (alt) tag += ` alt="${esc(alt)}"`
            if (title) tag += ` title="${esc(title)}"`
            if (width) tag += ` width="${width}"`
            if (height) tag += ` height="${height}"`
            state.write(`${tag}>`)
          } else {
            const escAlt = String(alt || '').replace(/[[\]]/g, '\\$&')
            state.write(`![${escAlt}](${src}${title ? ` "${String(title).replace(/"/g, '\\"')}"` : ''})`)
          }
          // TipTap 的 Image 默认是块级节点:必须收块,否则与后续段落黏连
          if (node.isBlock) state.closeBlock(node)
        },
        parse: {},
      },
    }
  },
})

// 换行:tiptap-markdown 默认序列化为反斜杠硬换行(\),会在用户源文里留下大量尾部反斜杠。
// 本应用统一 breaks 语义(单换行即换行,与预览 marked({breaks:true}) 一致),
// 平文换行在该语义下解析回 hardBreak,往返幂等;表格内用 <br>(表格行不能换行)。
const MdHardBreak = HardBreak.extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any, parent: any, index: number) {
          for (let i = index + 1; i < parent.childCount; i++) {
            if (parent.child(i).type !== node.type) {
              state.write(state.inTable ? '<br>' : '\n')
              return
            }
          }
        },
        parse: {},
      },
    }
  },
})

export function buildExtensions() {
  return [
    StarterKit.configure({
      // Underline 不是 Markdown 标准,禁用避免产出不可序列化的标记
      underline: false,
      // 换行序列化被 MdHardBreak 覆写
      hardBreak: false,
      link: { openOnClick: false, autolink: true },
    }),
    MdHardBreak,
    MdImage,
    TableKit.configure({ table: { resizable: false } }),
    Markdown.configure({
      html: true, // 允许内嵌 HTML(标准 Raw HTML,如 <img width>)
      breaks: true, // 与预览 marked({breaks:true}) 一致:单换行即换行
      linkify: false,
      transformPastedText: true, // 粘贴 Markdown 文本自动解析
      transformCopiedText: false,
    }),
  ]
}
