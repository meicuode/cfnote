// 渲染后增强(P10.5 代码高亮/公式;P11.3 Mermaid 图表):对 marked 产出的 HTML 做增强处理。
// highlight.js / KaTeX / mermaid 均按需懒加载——无对应内容的页面完全不拉取这些库。
// 幂等:处理过的节点打标记,MutationObserver 反复触发也不会重复处理或死循环。

async function highlightCode(root: HTMLElement) {
  // 排除 mermaid 代码块(交给 renderMermaid;否则会被当普通代码高亮糊掉)
  const blocks = root.querySelectorAll<HTMLElement>('pre code:not([data-hl]):not(.language-mermaid)')
  if (blocks.length === 0) return
  try {
    const hljs = (await import('highlight.js/lib/common')).default
    blocks.forEach((b) => {
      b.setAttribute('data-hl', '')
      try { hljs.highlightElement(b) } catch { /* 未知语言等:保持原样 */ }
    })
  } catch { /* 加载失败:代码块保持无高亮 */ }
}

async function renderMath(root: HTMLElement) {
  const nodes = root.querySelectorAll<HTMLElement>('.cfnote-math:not([data-rendered])')
  if (nodes.length === 0) return
  try {
    const katex = (await import('katex')).default
    await import('katex/dist/katex.min.css')
    nodes.forEach((el) => {
      el.setAttribute('data-rendered', '')
      const src = el.getAttribute('data-math') || ''
      try {
        katex.render(src, el, { displayMode: el.getAttribute('data-display') === '1', throwOnError: false })
      } catch {
        el.textContent = src // 渲染失败:退回显示原始公式
      }
    })
  } catch { /* 加载失败:公式保持占位文本 */ }
}

// Mermaid 图表(P11.3):把 ```mermaid 代码块渲染为 SVG。整库很大,仅在页面含 mermaid 块时才懒加载。
// 内容为笔记作者自有(可信);securityLevel 仍用 strict 兜底。渲染失败保留原始代码块,绝不崩整页。
let mermaidSeq = 0
async function renderMermaid(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>('pre code.language-mermaid:not([data-mermaid])')
  if (blocks.length === 0) return
  try {
    const mermaid = (await import('mermaid')).default
    const dark = document.documentElement.classList.contains('dark')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    for (const code of Array.from(blocks)) {
      code.setAttribute('data-mermaid', '') // 幂等:先占标记再异步渲染,并发触发不会重复处理
      const pre = code.closest('pre')
      if (!pre) continue
      const src = code.textContent || ''
      const id = `cfnote-mmd-${mermaidSeq++}`
      try {
        const { svg } = await mermaid.render(id, src)
        const wrap = document.createElement('div')
        wrap.className = 'cfnote-mermaid'
        wrap.innerHTML = svg
        pre.replaceWith(wrap)
      } catch {
        // 语法错误等:保留原始代码块(已打 data-mermaid 不再重试);清理 mermaid 可能残留的临时节点
        document.getElementById(id)?.remove()
        document.getElementById('d' + id)?.remove()
      }
    }
  } catch { /* 加载失败:mermaid 块保持为普通代码块 */ }
}

/** 对渲染后的容器做代码高亮 + 公式渲染 + Mermaid 图表(各自懒加载并行) */
export function enhanceRendered(root: HTMLElement | null | undefined) {
  if (!root) return
  void highlightCode(root)
  void renderMath(root)
  void renderMermaid(root)
}
