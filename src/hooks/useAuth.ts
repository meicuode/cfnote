import { useState, useCallback } from 'react'
import type { AuthState } from '../types'

const TOKEN_KEY = 'cfnote_token'
const USER_KEY = 'cfnote_user'
const FILE_COOKIE = 'cfnote_t'

// 附件读取凭据:token 以 cookie 副本随 <img>/同源 fetch 自动携带(图片标签带不上 Authorization 头)。
// 服务端仅在附件 GET/HEAD 路由接受该 cookie,写操作只认请求头,不引入 CSRF 面。
function syncFileCookie(token: string | null) {
  try {
    if (token) {
      document.cookie = `${FILE_COOKIE}=${token}; path=/api; SameSite=Lax; secure; max-age=2592000`
    } else {
      document.cookie = `${FILE_COOKIE}=; path=/api; SameSite=Lax; max-age=0`
    }
  } catch { /* 受限环境:私有附件预览需正常浏览器环境 */ }
}

// 模块加载即同步一次:已登录会话硬刷新后,页面里的 <img> 立刻能带上凭据
syncFileCookie(localStorage.getItem(TOKEN_KEY))

export function useAuth() {
  const [auth, setAuth] = useState<AuthState>(() => ({
    token: localStorage.getItem(TOKEN_KEY),
    username: localStorage.getItem(USER_KEY),
  }))

  const login = useCallback((token: string, username: string) => {
    localStorage.setItem(TOKEN_KEY, token)
    localStorage.setItem(USER_KEY, username)
    syncFileCookie(token)
    setAuth({ token, username })
  }, [])

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
    syncFileCookie(null)
    setAuth({ token: null, username: null })
  }, [])

  return { ...auth, isLoggedIn: !!auth.token, login, logout }
}
