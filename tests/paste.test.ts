// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import TurndownService from 'turndown'
import { buildExtensions } from '../src/lib/wysiwygExtensions'
import {
  looksLikeMarkdown,
  htmlCodeContainer,
  detectPaste,
  sourceModePasteText,
  wysiwygPasteAction,
  applyMarkdownPaste,
  applyCodePaste,
} from '../src/lib/pasteDetect'

// 粘贴修复验收:剪贴板同时带 text/html 与 text/plain 时,
// - Markdown/代码源文(VS Code、AI 代码块等高亮展示)必须用纯文本,源码模式不转义、富文本不套 ```markdown;
// - 真正的网页富文本(div/p 片段、完整 html 文档)保持原路径(源码 turndown、富文本 PM 解析)。

// 与 ArticleEditor 同配置的 turndown(源码模式的 HTML→MD 路径)
const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })

const roundtrip = (md: string): string => {
  const ed = new Editor({ extensions: buildExtensions(), content: md })
  const out = (ed.storage as any).markdown.getMarkdown()
  ed.destroy()
  return out
}

// 含代码块的 Markdown 源文(粘贴场景的核心 fixture)
const MD_DOC = [
  '# 标题',
  '',
  '正文含 **加粗** 与 `行内代码`。',
  '',
  '```ts',
  'const a = 1',
  'function f() { return "#not-heading" }',
  '```',
  '',
  '- 列表一',
  '- 列表二',
].join('\n')

// VS Code 复制源码时的剪贴板 HTML(等宽字体容器 + 逐行 div/span 高亮)
const VSCODE_HTML =
  '<div style="color: #cccccc;background-color: #1f1f1f;font-family: Consolas, \'Courier New\', monospace;' +
  'font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;">' +
  '<div><span style="color: #569cd6;"># 标题</span></div><div><span>```ts</span></div><div><span>const a = 1</span></div></div>'
const VSCODE_META_MD = JSON.stringify({ version: 1, isFromEmptySelection: false, multicursorText: null, mode: 'markdown' })
const VSCODE_META_TS = JSON.stringify({ version: 1, mode: 'typescript' })

// AI 聊天代码块整块复制:完整 html 文档外壳 + Windows 剪贴板 StartFragment 注释 + language-markdown
const AI_CODEBLOCK_MD_HTML =
  '<html><head><meta charset="utf-8"></head><body><!--StartFragment-->' +
  '<pre><code class="language-markdown"># 标题\n\n```ts\nconst a = 1\n```\n\n- 列表一</code></pre>' +
  '<!--EndFragment--></body></html>'

const PRE_TS_HTML = '<pre><code class="language-ts">const a = 1</code></pre>'
const PRE_BARE_HTML = '<div><pre>plain console output\nline2</pre></div>'

// 部分 html 片段(div/p/ul/pre 混合的网页富文本)与完整 html 文档
const RICH_FRAGMENT =
  '<div><h1>标题</h1><p>这是<strong>加粗</strong>段落</p><ul><li>一</li><li>二</li></ul>' +
  '<pre><code>const a = 1</code></pre></div>'
const RICH_FRAGMENT_TEXT = '标题\n这是加粗段落\n一\n二\nconst a = 1'
const RICH_P_HTML = '<p>只有一段<b>加粗</b>文字</p>'
const RICH_FULL_DOC =
  '<html><head><meta charset="utf-8"><style>p{margin:0}</style></head><body>' +
  '<p>网页<b>正文</b>段落。</p><p>第二段。</p></body></html>'

describe('粘贴判定:looksLikeMarkdown', () => {
  it('强信号:围栏代码块/标题/链接/表格/引用', () => {
    expect(looksLikeMarkdown(MD_DOC)).toBe(true)
    expect(looksLikeMarkdown('# 标题\n正文')).toBe(true)
    expect(looksLikeMarkdown('```\ncode\n```')).toBe(true)
    expect(looksLikeMarkdown('见 [文档](https://example.com)')).toBe(true)
    expect(looksLikeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(true)
    expect(looksLikeMarkdown('> 引用一句话')).toBe(true)
  })

  it('弱信号需组合:仅列表不算,列表+强调才算;普通文本不误判', () => {
    expect(looksLikeMarkdown('- 只有列表\n- 另一项')).toBe(false)
    expect(looksLikeMarkdown('- 列表 **加粗**')).toBe(true)
    expect(looksLikeMarkdown('普通一句话。\n第二句话。')).toBe(false)
    expect(looksLikeMarkdown('')).toBe(false)
  })
})

describe('粘贴判定:htmlCodeContainer', () => {
  it('VS Code 等宽字体容器 / 单个 pre(含完整文档外壳)识别为源码展示', () => {
    expect(htmlCodeContainer(VSCODE_HTML).isCode).toBe(true)
    expect(htmlCodeContainer(AI_CODEBLOCK_MD_HTML)).toEqual({ isCode: true, language: 'markdown' })
    expect(htmlCodeContainer(PRE_TS_HTML)).toEqual({ isCode: true, language: 'ts' })
    expect(htmlCodeContainer(PRE_BARE_HTML).isCode).toBe(true)
    expect(htmlCodeContainer(PRE_BARE_HTML).language).toBeUndefined()
  })

  it('网页富文本(div/p 片段、p+pre 混合、完整文档)不识别为源码展示', () => {
    expect(htmlCodeContainer(RICH_FRAGMENT).isCode).toBe(false)
    expect(htmlCodeContainer(RICH_P_HTML).isCode).toBe(false)
    expect(htmlCodeContainer(RICH_FULL_DOC).isCode).toBe(false)
  })
})

describe('粘贴判定:detectPaste 决策矩阵', () => {
  it('VS Code 元数据优先:markdown → markdown,其他语言 → code', () => {
    expect(detectPaste({ html: VSCODE_HTML, text: MD_DOC, vscodeMeta: VSCODE_META_MD })).toEqual({ kind: 'markdown' })
    expect(detectPaste({ html: VSCODE_HTML, text: 'const a = 1', vscodeMeta: VSCODE_META_TS })).toEqual({
      kind: 'code',
      language: 'typescript',
    })
  })

  it('代码容器 HTML:language-markdown → markdown;language-ts → code;无语言按文本特征分流', () => {
    expect(detectPaste({ html: AI_CODEBLOCK_MD_HTML, text: MD_DOC })).toEqual({ kind: 'markdown' })
    expect(detectPaste({ html: PRE_TS_HTML, text: 'const a = 1' })).toEqual({ kind: 'code', language: 'ts' })
    expect(detectPaste({ html: PRE_BARE_HTML, text: MD_DOC })).toEqual({ kind: 'markdown' })
    expect(detectPaste({ html: PRE_BARE_HTML, text: 'plain console output\nline2' })).toEqual({
      kind: 'code',
      language: undefined,
    })
  })

  it('网页富文本 → html;纯文本(无 html)→ text;html 无纯文本 → html', () => {
    expect(detectPaste({ html: RICH_FRAGMENT, text: RICH_FRAGMENT_TEXT }).kind).toBe('html')
    expect(detectPaste({ html: RICH_P_HTML, text: '只有一段加粗文字' }).kind).toBe('html')
    expect(detectPaste({ html: RICH_FULL_DOC, text: '网页正文段落。\n第二段。' }).kind).toBe('html')
    expect(detectPaste({ text: MD_DOC }).kind).toBe('text')
    expect(detectPaste({ html: RICH_P_HTML }).kind).toBe('html')
  })
})

describe('源码模式粘贴(sourceModePasteText)', () => {
  it('VS Code 复制的含代码块 Markdown:原样插入,字节级等于源文(反引号/井号不被转义)', () => {
    const out = sourceModePasteText({ html: VSCODE_HTML, text: MD_DOC, vscodeMeta: VSCODE_META_MD }, (h) => turndown.turndown(h))
    expect(out).toBe(MD_DOC)
  })

  it('AI 代码块复制的 Markdown(完整 html 文档外壳):原样插入', () => {
    const out = sourceModePasteText({ html: AI_CODEBLOCK_MD_HTML, text: MD_DOC }, (h) => turndown.turndown(h))
    expect(out).toBe(MD_DOC)
  })

  it('VS Code 复制的普通代码:原样插入,不走 turndown', () => {
    const code = 'const a = 1\nconst b = "#hash"'
    const out = sourceModePasteText({ html: VSCODE_HTML, text: code, vscodeMeta: VSCODE_META_TS }, (h) => turndown.turndown(h))
    expect(out).toBe(code)
  })

  it('网页富文本(div/p/ul/pre 混合片段):走 turndown 转 Markdown,代码块转围栏且不转义', () => {
    const out = sourceModePasteText({ html: RICH_FRAGMENT, text: RICH_FRAGMENT_TEXT }, (h) => turndown.turndown(h))!
    expect(out).toContain('# 标题')
    expect(out).toContain('**加粗**')
    expect(out).toContain('```')
    expect(out).toContain('const a = 1')
    expect(out).not.toContain('\\#')
    expect(out).not.toContain('\\`')
  })

  it('完整 html 文档:走 turndown;部分 p 片段同理;纯文本(无 html)返回 null 走浏览器默认', () => {
    const full = sourceModePasteText({ html: RICH_FULL_DOC, text: '网页正文段落。\n第二段。' }, (h) => turndown.turndown(h))!
    expect(full).toContain('**正文**')
    const p = sourceModePasteText({ html: RICH_P_HTML, text: '只有一段加粗文字' }, (h) => turndown.turndown(h))!
    expect(p).toContain('**加粗**')
    expect(sourceModePasteText({ text: MD_DOC }, (h) => turndown.turndown(h))).toBeNull()
  })
})

describe('富文本模式粘贴', () => {
  it('拦截决策:markdown 源 → markdown;代码 → code(带语言);网页富文本/纯文本 → 默认路径', () => {
    expect(wysiwygPasteAction({ html: VSCODE_HTML, text: MD_DOC, vscodeMeta: VSCODE_META_MD })).toEqual({ action: 'markdown' })
    expect(wysiwygPasteAction({ html: AI_CODEBLOCK_MD_HTML, text: MD_DOC })).toEqual({ action: 'markdown' })
    expect(wysiwygPasteAction({ html: VSCODE_HTML, text: 'const a = 1', vscodeMeta: VSCODE_META_TS })).toEqual({
      action: 'code',
      language: 'typescript',
    })
    expect(wysiwygPasteAction({ html: RICH_FRAGMENT, text: RICH_FRAGMENT_TEXT })).toBeNull()
    expect(wysiwygPasteAction({ html: RICH_FULL_DOC, text: '网页正文段落。' })).toBeNull()
    expect(wysiwygPasteAction({ text: MD_DOC })).toBeNull()
  })

  it('applyMarkdownPaste:含代码块的 Markdown 按结构插入,不套 ```markdown,代码块语言与内容保真', () => {
    const ed = new Editor({ extensions: buildExtensions(), content: '前文段落。' })
    applyMarkdownPaste(ed, MD_DOC)
    const md = (ed.storage as any).markdown.getMarkdown()
    ed.destroy()
    expect(md).not.toContain('```markdown')
    expect(md).toContain('# 标题')
    expect(md).toContain('```ts')
    expect(md).toContain('const a = 1')
    expect(md).toContain('"#not-heading"')
    expect(md).toContain('- 列表一')
    expect(md).toContain('前文段落。')
  })

  it('applyMarkdownPaste:空文档粘贴后结构稳定(再走标准往返幂等)', () => {
    const ed = new Editor({ extensions: buildExtensions(), content: '' })
    applyMarkdownPaste(ed, MD_DOC)
    const md = (ed.storage as any).markdown.getMarkdown()
    ed.destroy()
    expect(roundtrip(md)).toBe(md)
    expect(md).toContain('```ts')
  })

  it('applyCodePaste:纯代码进代码块,Markdown 特征字符原样保真不被结构化', () => {
    const ed = new Editor({ extensions: buildExtensions(), content: '' })
    applyCodePaste(ed, '# 注释不是标题\n**星号不是加粗**\nconst x = 1\n', 'python')
    const md = (ed.storage as any).markdown.getMarkdown()
    ed.destroy()
    expect(md).toContain('```python')
    // 内容整体在围栏内:围栏起始行在内容之前,且未被解析成标题/加粗
    expect(md.indexOf('```python')).toBeLessThan(md.indexOf('# 注释不是标题'))
    expect(md).toContain('**星号不是加粗**')
    expect(md.trimEnd().endsWith('```')).toBe(true)
  })

  it('applyCodePaste:无语言代码块;空文本不插入', () => {
    const ed = new Editor({ extensions: buildExtensions(), content: '' })
    applyCodePaste(ed, 'plain console output\nline2')
    const md = (ed.storage as any).markdown.getMarkdown()
    expect(/(^|\n)```\n/.test(md)).toBe(true)
    expect(md).toContain('line2')
    applyCodePaste(ed, '\n')
    ed.destroy()
  })
})
