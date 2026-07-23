import { describe, it, expect } from 'vitest'
import { marked } from '../src/lib/markdown'

describe('markdown 图片', () => {
  it('标准图片语法正常渲染', () => {
    const out = marked('![截图](/api/files/u1/abc/a.png)') as string
    expect(out).toContain('<img src="/api/files/u1/abc/a.png"')
    expect(out).toContain('alt="截图"')
  })

  it('内嵌 HTML img(标准的尺寸控制方式)原样透传,width/height 保留', () => {
    const inline = marked('前文 <img src="/x.png" width="300"> 后文') as string
    expect(inline).toContain('<img src="/x.png" width="300">')

    const block = marked('<img src="/x.png" width="300" height="200">') as string
    expect(block).toContain('width="300"')
    expect(block).toContain('height="200"')
  })
})

describe('markdown 删除线', () => {
  it('双波浪线生效,单波浪线(数字范围写法)不误伤', () => {
    expect(marked('~~删掉~~') as string).toContain('<del>')
    expect(marked('大约 50~100 之间') as string).not.toContain('<del>')
  })
})
