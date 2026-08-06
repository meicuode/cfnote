import { useState } from 'react'
import { formatRecoveryCode } from '../lib/recoveryCode'

interface Props {
  onComplete: (token: string, username: string) => void
  jwtMissing?: boolean
}

export default function SetupPage({ onComplete, jwtMissing }: Props) {
  const [step, setStep] = useState<'welcome' | 'init' | 'register'>('welcome')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPwd, setConfirmPwd] = useState('')
  // P17.2:注册就给恢复码,摆出来让人抄下来再放行进应用
  const [recoveryCode, setRecoveryCode] = useState('')
  const [loginData, setLoginData] = useState<{ token: string; username: string } | null>(null)

  const handleInit = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/init', { method: 'POST' })
      const json = await res.json() as any
      if (!json.ok) throw new Error(json.error)
      setStep('register')
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRegister = async () => {
    if (!username.trim() || !password) { setError('请填写所有字段'); return }
    if (password !== confirmPwd) { setError('两次密码不一致'); return }
    if (password.length < 6) { setError('密码至少6个字符'); return }
    setLoading(true)
    setError('')
    try {
      // Register
      const regRes = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const regJson = await regRes.json() as any
      if (!regJson.ok) throw new Error(regJson.error)

      // Auto login
      const loginRes = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const loginJson = await loginRes.json() as any
      if (!loginJson.ok) throw new Error(loginJson.error)

      // 先把恢复码摆出来,点了「我记下了」才进应用
      setRecoveryCode(regJson.data.recovery_code || '')
      setLoginData({ token: loginJson.data.token, username: loginJson.data.username })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg max-w-md w-full p-8">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-500 rounded-2xl mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">CFNote</h1>
          <p className="text-gray-500 mt-1">私人知识库</p>
        </div>

        {jwtMissing && (
          <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
            服务端未配置 <b>JWT_SECRET</b>，注册后将无法登录。请在 Cloudflare 仪表盘打开当前 Worker 的
            <b> Settings → Variables and Secrets</b>，添加名为 <b>JWT_SECRET</b> 的变量（类型选
            <b> Secret</b>，值为任意随机字符串），保存后刷新本页面。
          </div>
        )}

        {/* 注册成功:先把恢复码交出去再放行 */}
        {recoveryCode && loginData ? (
          <div className="space-y-4">
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              注册成功！在进入之前，<b>请务必抄下这个恢复码</b>。
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">你的恢复码</label>
              <code className="block w-full text-center font-mono text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-3 tracking-wider select-all break-all">
                {formatRecoveryCode(recoveryCode)}
              </code>
              <div className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mt-2 leading-relaxed space-y-1">
                <p>⚠️ <b>这是你忘记密码时唯一的自助出路</b>。不抄下来的话,下次忘了密码就只能去 Cloudflare 控制台改数据库。</p>
                <p>💡 以后可以在「设置 → 账号」里查看或换一个。</p>
              </div>
            </div>
            <button
              onClick={() => onComplete(loginData.token, loginData.username)}
              className="w-full bg-emerald-500 text-white rounded-lg px-4 py-3 font-medium hover:bg-emerald-600 transition-colors"
            >
              我记下了，进入
            </button>
          </div>
        ) : step === 'welcome' ? (
          <div className="text-center">
            <p className="text-gray-600 mb-6">
              欢迎使用 CFNote！这是您第一次使用，需要先初始化系统并创建账户。
            </p>
            <button
              onClick={handleInit}
              disabled={loading}
              className="w-full bg-emerald-500 text-white rounded-lg px-4 py-3 font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors"
            >
              {loading ? '初始化中...' : '初始化系统'}
            </button>
          </div>
        ) : null}

        {step === 'register' && !recoveryCode && (
          <div>
            <p className="text-gray-600 mb-6 text-center">系统已就绪，请创建您的账户</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  placeholder="2-32个字符"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                  placeholder="至少6个字符"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
                <input
                  type="password"
                  value={confirmPwd}
                  onChange={(e) => setConfirmPwd(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRegister()}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              <button
                onClick={handleRegister}
                disabled={loading}
                className="w-full bg-emerald-500 text-white rounded-lg px-4 py-3 font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors"
              >
                {loading ? '创建中...' : '创建账户'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-600 text-center bg-red-50 rounded-lg p-2">{error}</p>
        )}
      </div>
    </div>
  )
}
