// 渲染后增强(P10.5):对 marked 产出的 HTML 做代码高亮与数学公式渲染。
// highlight.js 与 KaTeX 都按需懒加载——无代码块/无公式的页面完全不拉取这两个库。
// 幂等:处理过的节点打标记,MutationObserver 反复触发也不会重复处理或死循环。

async function highlightCode(root: HTMLElement) {
  const blocks = root.querySelectorAll<HTMLElement>('pre code:not([data-hl])')
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

/** 对渲染后的容器做代码高亮 + 公式渲染(两者并行,各自懒加载) */
export function enhanceRendered(root: HTMLElement | null | undefined) {
  if (!root) return
  void highlightCode(root)
  void renderMath(root)
}
