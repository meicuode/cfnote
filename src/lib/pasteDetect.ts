// 粘贴内容判定(源码模式与富文本模式共用,纯逻辑,测试见 tests/paste.test.ts)。
//
// 背景:剪贴板常同时携带 text/html 与 text/plain。当复制来源是"Markdown/代码源文的高亮展示"
// (VS Code、AI 聊天代码块、GitHub 代码视图等)时,HTML 只是源文的外观,纯文本才是真正内容:
// - 源码模式若拿 HTML 走 turndown,会把 #、*、反引号等全部转义(代码块被转义坏掉);
// - 富文本模式若让 ProseMirror 解析 <pre><code class="language-markdown">,整篇会变成一个
//   ```markdown 代码块。
// 因此先判定剪贴板本质,再决定用哪份数据、走哪条解析路径。

export interface PasteInput {
  html?: string
  text?: string
  /** VS Code 复制时附带的 vscode-editor-data(JSON,含 mode 语言标识) */
  vscodeMeta?: string
}

export interface PasteDecision {
  kind: 'markdown' | 'code' | 'html' | 'text'
  language?: string
}

// 纯文本是否呈现明显 Markdown 特征(强信号任一命中即可;弱信号需组合出现)
export function looksLikeMarkdown(text: string): boolean {
  const t = text || ''
  if (/(^|\n)\s*```/.test(t)) return true // 围栏代码块
  if (/(^|\n)#{1,6}\s+\S/.test(t)) return true // ATX 标题
  if (/!?\[[^\]\n]*\]\([^)\n]+\)/.test(t)) return true // 链接/图片
  if (/(^|\n)\s*\|[^\n]*\|\s*\n\s*\|?[\s:|-]*-[\s:|-]*\|/.test(t)) return true // 表格(表头+分隔行)
  if (/(^|\n)>\s+\S/.test(t)) return true // 引用
  // 弱信号组合:列表与强调/行内代码同时出现才算(避免普通清单文本误判)
  const hasList = /(^|\n)\s*([-*+]|\d+\.)\s+\S/.test(t)
  const hasEmphasis = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|~~[^~\n]+~~)/.test(t)
  return hasList && hasEmphasis
}

const MONO_FONT_RE = /font-family:[^;"']*(consolas|menlo|monaco|courier|source code|mono)/i
const SKIP_TAGS = /^(META|STYLE|SCRIPT|LINK|TITLE|BASE)$/

// HTML 是否本质上是"源码展示容器":单个/一组 <pre>,或等宽字体样式的容器(VS Code 高亮风格)
export function htmlCodeContainer(html: string): { isCode: boolean; language?: string } {
  let body: HTMLElement
  try {
    body = new DOMParser().parseFromString(html, 'text/html').body
  } catch {
    return { isCode: false }
  }
  let kids = Array.from(body.children).filter((el) => !SKIP_TAGS.test(el.tagName))
  // 逐层剥掉单一包装(剪贴板常见 div 外壳),最多 4 层
  for (let depth = 0; depth < 4 && kids.length === 1; depth++) {
    const el = kids[0]
    if (el.tagName === 'PRE') break
    if (MONO_FONT_RE.test(el.getAttribute('style') || '')) return { isCode: true }
    if (/^(DIV|SPAN|SECTION|ARTICLE)$/.test(el.tagName) && el.children.length > 0) {
      kids = Array.from(el.children).filter((k) => !SKIP_TAGS.test(k.tagName))
      continue
    }
    break
  }
  if (kids.length >= 1 && kids.every((el) => el.tagName === 'PRE')) {
    const first = kids[0]
    const code = first.querySelector('code')
    const m = /language-([\w#+-]+)/.exec(`${code?.className || ''} ${first.className}`)
    return { isCode: true, language: m?.[1] }
  }
  return { isCode: false }
}

export function detectPaste(input: PasteInput): PasteDecision {
  const html = input.html || ''
  const text = input.text || ''
  if (!html) return { kind: 'text' }
  if (!text.trim()) return { kind: 'html' }
  let vsMode = ''
  if (input.vscodeMeta) {
    try {
      vsMode = String(JSON.parse(input.vscodeMeta).mode || '')
    } catch {
      /* 非标准数据,忽略 */
    }
  }
  if (/^(markdown|md)$/i.test(vsMode)) return { kind: 'markdown' }
  if (vsMode) return { kind: 'code', language: vsMode }
  const cc = htmlCodeContainer(html)
  if (cc.isCode) {
    if (cc.language && /^(markdown|md)$/i.test(cc.language)) return { kind: 'markdown' }
    if (!cc.language && looksLikeMarkdown(text)) return { kind: 'markdown' }
    return { kind: 'code', language: cc.language }
  }
  if (looksLikeMarkdown(text)) return { kind: 'markdown' }
  return { kind: 'html' }
}

// 源码模式(textarea):返回要插入的文本;null = 交给浏览器默认粘贴(纯文本场景)。
// 源码类剪贴板(markdown/code)原样插入纯文本,绝不 turndown;真正的网页富文本才 HTML→MD。
export function sourceModePasteText(input: PasteInput, htmlToMarkdown: (html: string) => string): string | null {
  const html = input.html || ''
  const text = input.text || ''
  if (!html) return null
  const d = detectPaste(input)
  if (d.kind !== 'html' && text) return text
  return htmlToMarkdown(html)
}

// 富文本模式:非 null 时拦截默认 HTML 解析,把纯文本按对应结构插入
export interface RichPasteAction {
  action: 'markdown' | 'code'
  language?: string
}

export function wysiwygPasteAction(input: PasteInput): RichPasteAction | null {
  if (!(input.html || '') || !(input.text || '').trim()) return null
  const d = detectPaste(input)
  if (d.kind === 'markdown') return { action: 'markdown' }
  if (d.kind === 'code') return { action: 'code', language: d.language }
  return null
}

// Markdown 粘贴:tiptap-markdown 覆写了 insertContentAt,字符串内容按 Markdown 解析
// (与其剪贴板纯文本路径同参 inline:true),因此直接 insertContent 即为库内同款解析
export function applyMarkdownPaste(editor: any, text: string): void {
  editor.chain().focus().insertContent(text).run()
}

// 代码粘贴:纯文本进代码块节点(对象形式插入不经 Markdown 解析,内容原样保真)
export function applyCodePaste(editor: any, text: string, language?: string): void {
  const code = text.replace(/\n$/, '')
  if (!code) return
  editor
    .chain()
    .focus()
    .insertContent({
      type: 'codeBlock',
      attrs: language ? { language } : {},
      content: [{ type: 'text', text: code }],
    })
    .run()
}
