import { describe, it, expect } from 'vitest'
import {
  workspaceOf, hasListPane, entryPane, backPane, canGoBack, paneForRoute,
  type Pane, type Workspace,
} from '../src/lib/pane'

describe('workspaceOf', () => {
  it('博客管理三个子视图:只有「已公开文章」是两栏', () => {
    expect(workspaceOf('articles', false)).toBe('blog-articles')
    expect(workspaceOf('comments', false)).toBe('blog-other')
    expect(workspaceOf('layout', false)).toBe('blog-other')
  })

  it('博客管理压过文件管理(Layout 的渲染顺序也是这个优先级)', () => {
    expect(workspaceOf('articles', true)).toBe('blog-articles')
    expect(workspaceOf('comments', true)).toBe('blog-other')
  })

  it('都没开就是笔记工作区', () => {
    expect(workspaceOf(null, true)).toBe('files')
    expect(workspaceOf(null, false)).toBe('notes')
  })
})

describe('hasListPane / entryPane', () => {
  it('笔记与已公开文章有列表层,文件管理与评论/布局没有', () => {
    expect(hasListPane('notes')).toBe(true)
    expect(hasListPane('blog-articles')).toBe(true)
    expect(hasListPane('files')).toBe(false)
    expect(hasListPane('blog-other')).toBe(false)
  })

  it('从侧栏进入:有列表层就停在列表,没有就直接进主内容', () => {
    expect(entryPane('notes')).toBe('list')
    expect(entryPane('blog-articles')).toBe('list')
    expect(entryPane('files')).toBe('main')
    expect(entryPane('blog-other')).toBe('main')
  })
})

describe('backPane', () => {
  it('笔记:正文 → 列表 → 侧栏', () => {
    expect(backPane('main', 'notes')).toBe('list')
    expect(backPane('list', 'notes')).toBe('nav')
  })

  it('文件管理没有列表层:从主内容一步回侧栏,不插一层空列表', () => {
    expect(backPane('main', 'files')).toBe('nav')
    expect(backPane('main', 'blog-other')).toBe('nav')
  })

  it('侧栏是栈底,再返回不动', () => {
    const all: Workspace[] = ['notes', 'files', 'blog-articles', 'blog-other']
    for (const ws of all) expect(backPane('nav', ws)).toBe('nav')
  })

  it('反复返回一定收敛到侧栏,不会来回弹', () => {
    for (const ws of ['notes', 'files', 'blog-articles', 'blog-other'] as Workspace[]) {
      let p: Pane = 'main'
      for (let i = 0; i < 5; i++) p = backPane(p, ws)
      expect(p).toBe('nav')
    }
  })
})

describe('canGoBack', () => {
  it('只有不在侧栏时才显示返回箭头', () => {
    expect(canGoBack('nav')).toBe(false)
    expect(canGoBack('list')).toBe(true)
    expect(canGoBack('main')).toBe(true)
  })
})

describe('paneForRoute', () => {
  it('占满工作区的面板 → 主内容', () => {
    expect(paneForRoute('files', false, false)).toBe('main')
    expect(paneForRoute('comments', false, false)).toBe('main')
    expect(paneForRoute('layout', false, false)).toBe('main')
  })

  it('博客管理的文章列表 → 列表层(还没选中任何一篇)', () => {
    expect(paneForRoute('blog', true, true)).toBe('list')
  })

  it('弹窗类面板不占层:按它们底下的视图算', () => {
    expect(paneForRoute('settings', true, true)).toBe('main')
    expect(paneForRoute('stats', true, false)).toBe('list')
    expect(paneForRoute('logs', false, false)).toBe('nav')
  })

  it('裸路由:有文章看文章,有笔记本看列表,都没有就停在侧栏', () => {
    expect(paneForRoute(null, true, true)).toBe('main')
    expect(paneForRoute(null, true, false)).toBe('list')
    expect(paneForRoute(null, false, false)).toBe('nav')
  })
})
