import { describe, it, expect } from 'vitest'
import { marked } from '../src/lib/markdown'

describe('markdown 图片尺寸语法', () => {
  it('![说明|300](url) 限宽,![说明|300x200](url) 限宽高,alt 不含尺寸后缀', () => {
    const w = marked('![截图|300](/api/files/u1/abc/a.png)') as string
    expect(w).toContain('width="300"')
    expect(w).not.toContain('height=')
    expect(w).toContain('alt="截图"')

    const wh = marked('![图|420x260](/x.png)') as string
    expect(wh).toContain('width="420"')
    expect(wh).toContain('height="260"')
  })

  it('无尺寸后缀/非法尺寸按普通图片渲染,alt 原样保留', () => {
    const plain = marked('![普通图](/x.png)') as string
    expect(plain).toContain('<img src="/x.png"')
    expect(plain).not.toContain('width=')

    const bad = marked('![a|abc](/x.png)') as string
    expect(bad).toContain('alt="a|abc"')
    expect(bad).not.toContain('width=')
  })

  it('alt/标题中的引号与尖括号被转义', () => {
    const out = marked('![a"<b>|120](/x.png "t\\"t")') as string
    expect(out).toContain('alt="a&quot;&lt;b&gt;"')
    expect(out).not.toContain('<b>')
  })
})

describe('markdown 删除线', () => {
  it('双波浪线生效,单波浪线(数字范围写法)不误伤', () => {
    expect(marked('~~删掉~~') as string).toContain('<del>')
    expect(marked('大约 50~100 之间') as string).not.toContain('<del>')
  })
})
