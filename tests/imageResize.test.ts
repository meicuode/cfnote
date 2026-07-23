import { describe, it, expect } from 'vitest'
import { findImages, setImageWidth } from '../src/lib/imageResize'

const MD = [
  '# 标题',
  '![首图](/api/files/u1/a/1.png)',
  '正文 <img src="/api/files/u1/b/2.png" title="t" width="500" height="300"> 继续',
  '```',
  '![代码块里的不算](/api/files/u1/a/1.png)',
  '```',
  '行内代码 `![也不算](/x.png)` 之后',
  '![首图second](/api/files/u1/a/1.png)',
].join('\n')

describe('findImages', () => {
  it('枚举 md 与 <img> 两种形式,跳过围栏代码块与行内代码', () => {
    const imgs = findImages(MD)
    expect(imgs).toHaveLength(3)
    expect(imgs[0]).toMatchObject({ src: '/api/files/u1/a/1.png', alt: '首图' })
    expect(imgs[1]).toMatchObject({ src: '/api/files/u1/b/2.png' })
    expect(imgs[2]).toMatchObject({ src: '/api/files/u1/a/1.png', alt: '首图second' })
  })
})

describe('setImageWidth', () => {
  it('markdown 形式改写为标准 <img>,同 src 按出现序号定位', () => {
    const out = setImageWidth(MD, '/api/files/u1/a/1.png', 1, 240)!
    expect(out).toContain('![首图](/api/files/u1/a/1.png)') // 第 0 个不动
    expect(out).toContain('<img src="/api/files/u1/a/1.png" alt="首图second" width="240">')
    expect(out).toContain('![代码块里的不算]') // 代码块原样
  })

  it('<img> 形式原位替换 width、移除 height,其余属性保留', () => {
    const out = setImageWidth(MD, '/api/files/u1/b/2.png', 0, 320)!
    expect(out).toContain('width="320"')
    expect(out).not.toContain('height="300"')
    expect(out).toContain('title="t"')
    expect(out).not.toContain('width="500"')
  })

  it('alt 中的引号被转义;找不到目标返回 null', () => {
    const out = setImageWidth('![a"b](/x.png)', '/x.png', 0, 100)!
    expect(out).toBe('<img src="/x.png" alt="a&quot;b" width="100">')
    expect(setImageWidth(MD, '/不存在.png', 0, 100)).toBeNull()
    expect(setImageWidth(MD, '/api/files/u1/a/1.png', 5, 100)).toBeNull()
  })
})
