import { marked } from 'marked'

// 属性安全转义:数学源码放进 data-math 属性,渲染时由 renderEnhance 用 KaTeX 渲染
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 全局 marked 配置:仅识别 ~~双波浪线~~ 为删除线。
// GFM 默认单个 ~ 也触发删除线,AI 回答中"50~100"这类范围写法会把中间文字整段划掉。
// 图片尺寸不做私有语法扩展:按 Markdown 标准用内嵌 HTML 控制,
// 如 <img src="/api/files/..." width="300">(CommonMark 的 Raw HTML,marked 原样透传)。
marked.use({
  tokenizer: {
    del(src: string) {
      const match = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src)
      if (!match) return undefined
      return {
        type: 'del',
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1]),
      }
    },
  } as any,
})

// 数学公式(KaTeX,$…$ 行内 / $$…$$ 块级;GitHub/Pandoc 通行写法,非私有方言)。
// 这里只把公式**切分为占位元素**(不解析内部 markdown),真正渲染在 renderEnhance.ts 懒加载 KaTeX 完成——
// 保证无公式的页面完全不加载 KaTeX。
marked.use({
  extensions: [
    {
      name: 'mathBlock',
      level: 'block',
      start(src: string) { const i = src.indexOf('$$'); return i < 0 ? undefined : i },
      tokenizer(src: string) {
        const m = /^\$\$([\s\S]+?)\$\$/.exec(src)
        if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() }
        return undefined
      },
      renderer(t: any) { return `<div class="cfnote-math" data-display="1" data-math="${escAttr(t.text)}"></div>` },
    },
    {
      name: 'mathInline',
      level: 'inline',
      start(src: string) { const i = src.indexOf('$'); return i < 0 ? undefined : i },
      tokenizer(src: string) {
        // $…$:紧邻 $ 的两侧非空白,闭合 $ 后不接数字(避开 "$5 与 $10" 这类价格)
        const m = /^\$(?!\s)((?:\\.|[^$\\])+?)(?<!\s)\$(?!\d)/.exec(src)
        if (m) return { type: 'mathInline', raw: m[0], text: m[1] }
        return undefined
      },
      renderer(t: any) { return `<span class="cfnote-math" data-display="0" data-math="${escAttr(t.text)}"></span>` },
    },
  ],
})

export { marked }
