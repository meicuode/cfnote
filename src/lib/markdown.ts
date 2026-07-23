import { marked } from 'marked'

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// 全局 marked 配置:
// 1) 仅识别 ~~双波浪线~~ 为删除线(GFM 默认单个 ~ 也触发,"50~100"这类范围写法会被误划掉)
// 2) 图片尺寸语法:![说明|300](url) 限宽 300px,![说明|300x200](url) 同时限高
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
  renderer: {
    image(token: any) {
      const raw: string = token.text ?? ''
      const m = /^(.*?)\|(\d{2,4})(?:x(\d{2,4}))?$/.exec(raw)
      const alt = m ? m[1] : raw
      const size = m ? ` width="${m[2]}"${m[3] ? ` height="${m[3]}"` : ''}` : ''
      const title = token.title ? ` title="${esc(token.title)}"` : ''
      return `<img src="${esc(token.href || '')}" alt="${esc(alt)}"${title}${size} loading="lazy">`
    },
  } as any,
})

export { marked }
