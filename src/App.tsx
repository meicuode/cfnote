import { useState, useEffect, lazy, Suspense } from 'react'
import { useAuth } from './hooks/useAuth'
import SetupPage from './components/SetupPage'
import LoginPage from './components/LoginPage'
import Layout from './components/Layout'

// 公开博客页(免登录,独立 chunk):/blog 列表,/blog/:id 详情
const BlogPage = lazy(() => import('./components/BlogPage'))
const IS_BLOG = /^\/blog(\/|$)/.test(window.location.pathname)

type AppState = 'loading' | 'setup' | 'login' | 'app'

export default function App() {
  // 博客路径不进入应用壳(无鉴权、不请求 /api/status);模块级常量保证 hooks 顺序稳定
  if (IS_BLOG) {
    return (
      <Suspense fallback={<div className="min-h-screen bg-[#262626]" />}>
        <BlogPage />
      </Suspense>
    )
  }
  return <MainApp />
}

function MainApp() {
  const { token, username, isLoggedIn, login, logout } = useAuth()
  const [state, setState] = useState<AppState>('loading')
  const [jwtMissing, setJwtMissing] = useState(false)

  useEffect(() => {
    checkStatus()
  }, [])

  useEffect(() => {
    if (state === 'loading') return
    if (isLoggedIn) setState('app')
  }, [isLoggedIn])

  const checkStatus = async () => {
    try {
      const res = await fetch('/api/status')
      const json = await res.json() as any
      if (json.ok && json.data?.jwt_secret_configured === false) setJwtMissing(true)
      if (!json.ok || !json.data?.initialized || !json.data?.hasUser) {
        setState('setup')
      } else if (isLoggedIn) {
        setState('app')
      } else {
        setState('login')
      }
    } catch {
      setState('setup')
    }
  }

  const handleSetupComplete = (t: string, u: string) => {
    login(t, u)
    setState('app')
  }

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center">
        <div className="text-center">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-500 rounded-2xl mb-4 animate-pulse">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <p className="text-gray-500">加载中...</p>
        </div>
      </div>
    )
  }

  if (state === 'setup') return <SetupPage onComplete={handleSetupComplete} jwtMissing={jwtMissing} />
  if (state === 'login') return <LoginPage onLogin={(t, u) => { login(t, u); setState('app') }} jwtMissing={jwtMissing} />

  return <Layout token={token!} username={username!} onLogout={() => { logout(); setState('login') }} />
}
