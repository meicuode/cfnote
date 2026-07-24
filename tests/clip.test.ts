import { describe, it, expect } from 'vitest'
import { buildBookmarklet, CLIP_ACK, CLIP_MAX_HTML } from '../src/lib/clip'

describe('buildBookmarklet', () => {
  const url = buildBookmarklet('https://cfnote.example.workers.dev')

  it('是 javascript: 协议且已 URI 编码', () => {
    expect(url.startsWith('javascript:')).toBe(true)
    // 编码后不应残留裸空格/花括号
    expect(url).not.toMatch(/[ {}]/)
  })

  it('内嵌站点 origin 与 ack 常量', () => {
    const decoded = decodeURIComponent(url.slice('javascript:'.length))
    expect(decoded).toContain("'https://cfnote.example.workers.dev'")
    expect(decoded).toContain(CLIP_ACK)
    expect(decoded).toContain(String(CLIP_MAX_HTML))
  })

  it('打开 /clip 页并携带标题/URL/HTML', () => {
    const decoded = decodeURIComponent(url.slice('javascript:'.length))
    expect(decoded).toContain("o+'/clip'")
    expect(decoded).toContain('document.title')
    expect(decoded).toContain('location.href')
    expect(decoded).toContain("type:'cfnote-clip'")
  })
})
