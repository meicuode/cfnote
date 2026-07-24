// 博客页明暗主题解析:手动选择(localStorage)优先,否则跟随系统 prefers-color-scheme。
// 独立小模块:App.tsx 的 Suspense fallback 与 BlogPage 共用,保证首屏底色与最终主题一致(无闪色)。

export const BLOG_THEME_KEY = 'cfnote:blog-theme'

export type BlogTheme = 'light' | 'dark'

/** 用户手动选择过的主题;没选过或值非法返回 null(表示跟随系统) */
export function storedBlogTheme(): BlogTheme | null {
  try {
    const v = localStorage.getItem(BLOG_THEME_KEY)
    return v === 'light' || v === 'dark' ? v : null
  } catch {
    return null
  }
}

/** 系统偏好;环境不支持 matchMedia 时回退 dark(博客的原生配色) */
export function systemBlogTheme(): BlogTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'dark'
  }
}

export function initialBlogTheme(): BlogTheme {
  return storedBlogTheme() ?? systemBlogTheme()
}

export function saveBlogTheme(theme: BlogTheme): void {
  try {
    localStorage.setItem(BLOG_THEME_KEY, theme)
  } catch {
    /* 隐私模式等存储不可用:本次会话内仍生效 */
  }
}
