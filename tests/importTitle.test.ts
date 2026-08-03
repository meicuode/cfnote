import { describe, it, expect } from 'vitest'
import { importTitle } from '../src/lib/importTitle'

/** 选单个文件时 webkitRelativePath 是空串 */
const pick = (name: string) => ({ name, webkitRelativePath: '' })
/** 选文件夹时每个 File 都带上从选中目录算起的相对路径 */
const inDir = (rel: string) => ({ name: rel.split('/').pop() || rel, webkitRelativePath: rel })

describe('importTitle', () => {
  it('选单个文件:就是去掉扩展名的文件名', () => {
    expect(importTitle(pick('部署笔记.md'))).toBe('部署笔记')
    expect(importTitle(pick('readme.markdown'))).toBe('readme')
    expect(importTitle(pick('随手记.txt'))).toBe('随手记')
  })

  it('文件夹根目录下的文件:剥掉根之后只剩文件名,跟选单文件一样', () => {
    expect(importTitle(inDir('我的笔记/部署.md'))).toBe('部署')
  })

  it('子目录里的文件:标题带上相对路径,同名文件因此能区分开', () => {
    expect(importTitle(inDir('我的笔记/技术/index.md'))).toBe('技术/index')
    expect(importTitle(inDir('我的笔记/读书/index.md'))).toBe('读书/index')
    expect(importTitle(inDir('我的笔记/技术/前端/index.md'))).toBe('技术/前端/index')
  })

  it('扩展名大小写不敏感', () => {
    expect(importTitle(pick('README.MD'))).toBe('README')
    expect(importTitle(inDir('nb/A/NOTE.Markdown'))).toBe('A/NOTE')
  })

  it('只匹配结尾的扩展名,名字中间的同名片段不动', () => {
    expect(importTitle(pick('a.md.backup.md'))).toBe('a.md.backup')
    expect(importTitle(pick('note.txt.md'))).toBe('note.txt')
  })

  it('没有扩展名就原样保留', () => {
    expect(importTitle(pick('LICENSE'))).toBe('LICENSE')
    expect(importTitle(inDir('nb/docs/CHANGELOG'))).toBe('docs/CHANGELOG')
  })

  it('去完扩展名什么都不剩时退回原始文件名,目录段照样保留', () => {
    expect(importTitle(pick('.md'))).toBe('.md')
    // 不是 '.markdown':扩展名只从文件名那段去,目录前缀不受影响。
    // 早先的实现拼好整条路径再去扩展名,这里会吐出吊着斜杠的 'sub/'
    expect(importTitle(inDir('nb/sub/.markdown'))).toBe('sub/.markdown')
  })

  it('目录名里带扩展名样式的后缀也不会被削掉', () => {
    expect(importTitle(inDir('nb/archive.md/note.md'))).toBe('archive.md/note')
  })

  it('relativePath 不足两段(不是文件夹选择)时退回 name', () => {
    expect(importTitle({ name: 'a.md', webkitRelativePath: 'a.md' })).toBe('a')
  })

  it('缺少 webkitRelativePath 字段也不报错', () => {
    expect(importTitle({ name: 'a.md' })).toBe('a')
  })
})
