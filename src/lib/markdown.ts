import { marked } from 'marked'

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

export { marked }
