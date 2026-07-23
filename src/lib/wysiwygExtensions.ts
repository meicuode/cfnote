import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import HardBreak from '@tiptap/extension-hard-break'
import { TableKit } from '@tiptap/extension-table'
import { Node } from '@tiptap/core'
import { Markdown } from 'tiptap-markdown'
import { formatBytes, formatDateTime } from './format'

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

// P6.3 xmind 卡片:.xmind 链接在富文本内渲染为缩略图卡片(原子节点)。
// 性能硬约束:编辑器内绝不实例化 simple-mind-map,卡片只是一张边车缩略图(<url>.thumb.png),
// 双击才经回调打开懒加载的 XmindViewer 弹窗;一篇文章多个卡片也只是多几个 <img>。
// 持久化仍是标准 MD 链接 [显示名](url),卡片上唯一可编辑的是显示名。

export interface WysiwygOptions {
  /** 双击卡片:打开 XmindViewer 弹窗(由父组件承载) */
  onOpenXmind?: (url: string, name: string) => void
  /** 点击 ✏️:请求改显示名,组件弹窗确认后对 pos 处节点 setNodeMarkup */
  onRenameXmind?: (pos: number, label: string) => void
}

const isXmindHref = (href: string) => {
  try {
    return /\.xmind$/i.test(decodeURIComponent(href))
  } catch {
    return /\.xmind$/i.test(href)
  }
}

const XmindCard = Node.create<WysiwygOptions>({
  name: 'xmindCard',
  inline: true,
  group: 'inline',
  atom: true,
  draggable: true,
  marks: '',

  addOptions() {
    return { onOpenXmind: undefined, onRenameXmind: undefined }
  },

  addAttributes() {
    return {
      href: { default: '' },
      label: { default: '' },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'a[href]',
        // 高于 Link mark(默认 50):.xmind 链接优先解析为卡片节点,其余链接原样落回 link mark
        priority: 100,
        getAttrs: (el) => {
          const a = el as HTMLElement
          const href = a.getAttribute('href') || ''
          if (!isXmindHref(href)) return false
          return { href, label: a.textContent || '' }
        },
      },
    ]
  },

  renderHTML({ node }) {
    // 剪贴板/降级形态保持 <a> 链接:复制粘贴经 parseHTML 还原为卡片
    return ['a', { href: node.attrs.href, class: 'cfnote-xmind-card' }, node.attrs.label || 'XMind']
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const label = String(node.attrs.label || '').replace(/[[\]]/g, '\\$&')
          state.write(`[${label}](${node.attrs.href})`)
        },
        parse: {},
      },
    }
  },

  addNodeView() {
    const opts = this.options
    return ({ node: initialNode, editor, getPos }) => {
      let node = initialNode
      const dom = document.createElement('a')
      dom.className = 'cfnote-xmind-card'
      dom.contentEditable = 'false'

      const img = document.createElement('img')
      img.alt = ''
      img.loading = 'lazy'
      const ph = document.createElement('div')
      ph.className = 'cfnote-xmind-placeholder'
      ph.innerHTML = '<em>🧠</em><b>XMind 思维导图</b>'
      ph.style.display = 'none'
      img.onerror = () => {
        img.style.display = 'none'
        ph.style.display = 'flex'
      }
      img.onload = () => {
        img.style.display = ''
        ph.style.display = 'none'
      }

      const span = document.createElement('span')
      const rename = document.createElement('button')
      rename.type = 'button'
      rename.className = 'cfnote-xmind-rename'
      rename.title = '修改显示名'
      rename.textContent = '✏️'

      dom.appendChild(img)
      dom.appendChild(ph)
      dom.appendChild(span)
      dom.appendChild(rename)

      const displayLabel = () => {
        const l = String(node.attrs.label || '').replace(/^📎\s*/, '')
        if (l) return l
        const raw = String(node.attrs.href || '').split('/').pop() || 'XMind'
        try {
          return decodeURIComponent(raw)
        } catch {
          return raw
        }
      }
      let thumbV = ''
      const sync = () => {
        span.textContent = `🧠 ${displayLabel()}`
        const src = `${node.attrs.href}.thumb.png${thumbV}`
        if (img.getAttribute('src') !== src) img.setAttribute('src', src)
        dom.title = `${displayLabel()}\n双击打开 · ✏️ 改名`
      }
      sync()

      // HEAD 元信息(大小/创建/修改)懒取:首次悬浮才请求,与预览卡片同一展示格式
      let metaLoaded = false
      dom.addEventListener('mouseenter', () => {
        if (metaLoaded) return
        metaLoaded = true
        fetch(node.attrs.href, { method: 'HEAD' })
          .then((r) => {
            if (!r.ok) return
            const size = Number(r.headers.get('content-length'))
            const created = r.headers.get('x-created')
            const modified = r.headers.get('last-modified')
            if (size > 0 && span.isConnected) span.textContent = `🧠 ${displayLabel()} · ${formatBytes(size)}`
            dom.title = [
              displayLabel(),
              size > 0 ? `大小：${formatBytes(size)}` : '',
              created ? `创建：${formatDateTime(created)}` : '',
              modified ? `修改：${formatDateTime(modified)}` : '',
              '双击打开 · ✏️ 改名',
            ].filter(Boolean).join('\n')
          })
          .catch(() => {})
      })

      // 单击留给 ProseMirror 选中节点(可 Backspace 删除);双击打开查看器
      dom.addEventListener('click', (e) => e.preventDefault())
      dom.addEventListener('dblclick', (e) => {
        e.preventDefault()
        e.stopPropagation()
        opts.onOpenXmind?.(node.attrs.href, displayLabel())
      })
      rename.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
      })
      rename.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (!editor.isEditable) return
        const pos = typeof getPos === 'function' ? getPos() : undefined
        if (typeof pos === 'number') opts.onRenameXmind?.(pos, String(node.attrs.label || ''))
      })

      // 查看器内保存后父组件派发该事件:带版本号重取缩略图,绕过 immutable 强缓存
      const onThumb = (e: Event) => {
        const u = String((e as CustomEvent).detail?.url || '')
        if (!u) return
        const norm = (s: string) => {
          try {
            return decodeURIComponent(s)
          } catch {
            return s
          }
        }
        if (norm(u) !== norm(String(node.attrs.href || ''))) return
        thumbV = `?v=${Date.now()}`
        img.style.display = ''
        ph.style.display = 'none'
        img.setAttribute('src', `${node.attrs.href}.thumb.png${thumbV}`)
      }
      window.addEventListener('cfnote:xmind-thumb', onThumb)

      return {
        dom,
        update(n) {
          if (n.type.name !== 'xmindCard') return false
          node = n
          sync()
          return true
        },
        ignoreMutation: () => true,
        destroy() {
          window.removeEventListener('cfnote:xmind-thumb', onThumb)
        },
      }
    }
  },
})

export function buildExtensions(opts: WysiwygOptions = {}) {
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
    XmindCard.configure({ onOpenXmind: opts.onOpenXmind, onRenameXmind: opts.onRenameXmind }),
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
