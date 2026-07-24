import { describe, it, expect } from 'vitest'
import { parseFileRefs, buildAfileUrl, afileTailKind, categorizeFile, SIDECAR_SUFFIX } from '../src/lib/fileRefs'

// P8.1 附件链接双方案:旧式 /api/files/<真实key> 与新式 /api/afile/<id>/<名> 的解析、
// afile 尾巴分流(主文件/边车缩略图)、分类推导。

describe('parseFileRefs 双方案提取', () => {
  it('同一篇内容中新旧链接都能提取', () => {
    const md = [
      '![旧图](/api/files/u1/abc123/old.png)',
      '![新图](/api/afile/42/new.png)',
      '[📎 文档](/api/afile/43/%E8%AE%A1%E5%88%92.docx)',
    ].join('\n')
    const refs = parseFileRefs(md, 1)
    expect(refs.keys).toEqual(['u1/abc123/old.png'])
    expect(refs.ids.sort()).toEqual([42, 43])
  })

  it('旧式按用户前缀过滤,新式 id 不受影响', () => {
    const md = '![a](/api/files/u2/k/x.png) ![b](/api/afile/7/y.png)'
    const refs = parseFileRefs(md, 1)
    expect(refs.keys).toEqual([])
    expect(refs.ids).toEqual([7])
  })

  it('afile 链接省略尾巴也能提取 id;重复引用去重', () => {
    const md = '看 [这个](/api/afile/5) 和 ![](/api/afile/5/a.png) 以及 ![](/api/afile/5/a.png)'
    expect(parseFileRefs(md).ids).toEqual([5])
  })

  it('HTML img 标签中的链接同样提取(引号截断)', () => {
    const md = '<img src="/api/afile/9/pic.png" width="300"> <img src="/api/files/u1/kk/z.jpg">'
    const refs = parseFileRefs(md, 1)
    expect(refs.ids).toEqual([9])
    expect(refs.keys).toEqual(['u1/kk/z.jpg'])
  })

  it('外部链接与普通数字路径不误提取', () => {
    const md = '[站点](https://example.com/api/afile/1/x.png) 之外还有 /api/articles/12'
    // 外链中包含的 /api/afile/ 子串会被提取——与旧式 key 行为一致,引用登记宁多勿漏(查无此 id 自然忽略)
    expect(parseFileRefs(md).ids).toEqual([1])
    expect(parseFileRefs('/api/articles/12 和 /api/afile/x/y.png').ids).toEqual([])
  })
})

describe('buildAfileUrl 与尾巴分流', () => {
  it('生成的链接编码文件名,拼 .thumb.png 后仍指向同一 id 的边车', () => {
    const url = buildAfileUrl(42, '计划.xmind')
    expect(url).toBe('/api/afile/42/%E8%AE%A1%E5%88%92.xmind')
    // 客户端边车拼接约定:主链接 + .thumb.png
    const sidecarTail = decodeURIComponent(`${url}${SIDECAR_SUFFIX}`.split('/').pop()!)
    expect(afileTailKind(sidecarTail, '计划.xmind')).toBe('sidecar')
  })

  it('尾巴等于注册名 → 主文件;注册名.thumb.png → 边车', () => {
    expect(afileTailKind('a.xmind', 'a.xmind')).toBe('main')
    expect(afileTailKind('a.xmind.thumb.png', 'a.xmind')).toBe('sidecar')
  })

  it('改名后的陈旧尾巴容忍:旧名 → 主文件,旧名.thumb.png → 边车', () => {
    expect(afileTailKind('旧名.xmind', '新名.xmind')).toBe('main')
    expect(afileTailKind('旧名.xmind.thumb.png', '新名.xmind')).toBe('sidecar')
  })

  it('文件本身叫 *.thumb.png 时,尾巴与注册名相等仍是主文件', () => {
    expect(afileTailKind('海报.thumb.png', '海报.thumb.png')).toBe('main')
  })

  it('空尾巴按主文件处理', () => {
    expect(afileTailKind('', 'a.png')).toBe('main')
  })
})

describe('categorizeFile 分类推导', () => {
  it('图片:按 content-type 或扩展名', () => {
    expect(categorizeFile('x.bin', 'image/png')).toBe('image')
    expect(categorizeFile('照片.JPG')).toBe('image')
    expect(categorizeFile('logo.svg')).toBe('image')
  })

  it('文档:office/pdf/文本/代码', () => {
    expect(categorizeFile('报告.docx')).toBe('doc')
    expect(categorizeFile('数据.xlsx')).toBe('doc')
    expect(categorizeFile('说明.pdf', 'application/pdf')).toBe('doc')
    expect(categorizeFile('README.md')).toBe('doc')
    expect(categorizeFile('script.js')).toBe('doc')
    expect(categorizeFile('notes.txt', 'text/plain')).toBe('doc')
  })

  it('其他:xmind/压缩包/未知', () => {
    expect(categorizeFile('导图.xmind')).toBe('other')
    expect(categorizeFile('打包.zip')).toBe('other')
    expect(categorizeFile('file', 'application/octet-stream')).toBe('other')
  })
})
