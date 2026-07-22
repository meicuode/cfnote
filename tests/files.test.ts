import { describe, it, expect } from 'vitest'
import { extractFileKeys } from '../worker/routes/files'

describe('extractFileKeys', () => {
  it('提取图片与附件链接中的 key', () => {
    const content = [
      '![截图](/api/files/u1/abc123DEF/screenshot.png)',
      '[📎 计划.xmind](/api/files/u1/ffee00aa11/计划.xmind)',
    ].join('\n')
    expect(extractFileKeys(content, 1)).toEqual([
      'u1/abc123DEF/screenshot.png',
      'u1/ffee00aa11/计划.xmind',
    ])
  })

  it('忽略其他用户的 key 与普通链接', () => {
    const content = '![x](/api/files/u2/abc/y.png) [站点](https://example.com/a.png)'
    expect(extractFileKeys(content, 1)).toEqual([])
  })

  it('同一附件多次引用去重', () => {
    const content = '![a](/api/files/u1/k1/a.png)\n![b](/api/files/u1/k1/a.png)'
    expect(extractFileKeys(content, 1)).toEqual(['u1/k1/a.png'])
  })

  it('URL 编码的文件名解码为原始 key', () => {
    const content = '[f](/api/files/u1/k2/%E8%AE%A1%E5%88%92.xmind)'
    expect(extractFileKeys(content, 1)).toEqual(['u1/k2/计划.xmind'])
  })

  it('空内容返回空数组', () => {
    expect(extractFileKeys('', 1)).toEqual([])
  })
})
