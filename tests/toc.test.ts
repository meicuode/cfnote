import { describe, it, expect } from 'vitest'
import { slugifyHeading, tocIndent, MIN_TOC_HEADINGS, type TocItem } from '../src/lib/toc'

describe('slugifyHeading(章节锚点,P11.8)', () => {
  it('中文标题原样保留(可读的分享链接)', () => {
    expect(slugifyHeading('部署步骤')).toBe('部署步骤')
    expect(slugifyHeading('三、常见问题')).toBe('三常见问题')
  })

  it('英文转小写,空白转连字符', () => {
    expect(slugifyHeading('Getting  Started')).toBe('getting-started')
    expect(slugifyHeading('  Deploy to CF  ')).toBe('deploy-to-cf')
  })

  it('丢弃标点,不留首尾与连续连字符', () => {
    expect(slugifyHeading('Step 1: 安装依赖!')).toBe('step-1-安装依赖')
    expect(slugifyHeading('--- ??? ---')).toBe('section')
    expect(slugifyHeading('')).toBe('section')
  })

  it('重名自动加序号,不会两个标题抢同一个锚点', () => {
    const used = new Set<string>()
    expect(slugifyHeading('小结', used)).toBe('小结')
    expect(slugifyHeading('小结', used)).toBe('小结-2')
    expect(slugifyHeading('小结', used)).toBe('小结-3')
    // 不传 used 时不去重(纯转换)
    expect(slugifyHeading('小结')).toBe('小结')
  })

  it('空标题重名也能各自拿到唯一 id', () => {
    const used = new Set<string>()
    expect(slugifyHeading('!!!', used)).toBe('section')
    expect(slugifyHeading('???', used)).toBe('section-2')
  })
})

describe('tocIndent(相对缩进,P11.8)', () => {
  const mk = (level: number, id: string): TocItem => ({ id, text: id, level })

  it('整篇最浅的标题算第 0 层', () => {
    const items = [mk(2, 'a'), mk(3, 'b'), mk(2, 'c')]
    expect(tocIndent(items[0], items)).toBe(0)
    expect(tocIndent(items[1], items)).toBe(1)
    expect(tocIndent(items[2], items)).toBe(0)
  })

  it('全篇同级时不白缩进一格', () => {
    const items = [mk(3, 'a'), mk(3, 'b')]
    expect(items.every((t) => tocIndent(t, items) === 0)).toBe(true)
  })

  it('显示门槛是 3 条', () => {
    expect(MIN_TOC_HEADINGS).toBe(3)
  })
})
