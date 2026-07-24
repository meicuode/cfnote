// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { BLOG_THEME_KEY, initialBlogTheme, storedBlogTheme, systemBlogTheme, saveBlogTheme } from '../src/lib/blogTheme'

// 博客主题解析优先级:localStorage 手动选择 > 系统 prefers-color-scheme > 回退 dark

const mockMatchMedia = (dark: boolean) => {
  ;(window as any).matchMedia = (query: string) => ({
    matches: dark && query.includes('dark'),
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })
}

beforeEach(() => {
  localStorage.clear()
})

describe('博客主题解析', () => {
  it('未手动选择时跟随系统:系统深色 → dark', () => {
    mockMatchMedia(true)
    expect(storedBlogTheme()).toBeNull()
    expect(initialBlogTheme()).toBe('dark')
  })

  it('未手动选择时跟随系统:系统浅色 → light', () => {
    mockMatchMedia(false)
    expect(initialBlogTheme()).toBe('light')
  })

  it('手动选择优先于系统偏好', () => {
    mockMatchMedia(true)
    saveBlogTheme('light')
    expect(storedBlogTheme()).toBe('light')
    expect(initialBlogTheme()).toBe('light')
  })

  it('存储值非法时视为未选择,回落系统偏好', () => {
    localStorage.setItem(BLOG_THEME_KEY, 'blue')
    mockMatchMedia(false)
    expect(storedBlogTheme()).toBeNull()
    expect(initialBlogTheme()).toBe('light')
  })

  it('matchMedia 不可用的环境回退 dark(博客原生配色)', () => {
    ;(window as any).matchMedia = undefined
    expect(systemBlogTheme()).toBe('dark')
    expect(initialBlogTheme()).toBe('dark')
  })

  it('saveBlogTheme 持久化到 localStorage 指定键', () => {
    saveBlogTheme('dark')
    expect(localStorage.getItem(BLOG_THEME_KEY)).toBe('dark')
  })
})
