import { describe, it, expect } from 'vitest'
import { parseTags } from '../src/types'

describe('parseTags', () => {
  it('JSON 数组文本解析为字符串数组', () => {
    expect(parseTags('["前端","cloudflare"]')).toEqual(['前端', 'cloudflare'])
  })

  it('空值与坏值容错为空数组', () => {
    expect(parseTags(null)).toEqual([])
    expect(parseTags(undefined)).toEqual([])
    expect(parseTags('')).toEqual([])
    expect(parseTags('not json')).toEqual([])
    expect(parseTags('{"a":1}')).toEqual([])
  })

  it('数组元素强转字符串', () => {
    expect(parseTags('[1,"x"]')).toEqual(['1', 'x'])
  })
})
