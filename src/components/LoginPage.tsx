import { useState } from 'react'
import { formatRecoveryCode, isRecoveryCodeShape } from '../lib/recoveryCode'

interface Props {
  onLogin: (token: string, username: string) => void
  jwtMissing?: boolean
}

export default function LoginPage({ onLogin, jwtMissing }: Props) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  // P17.2 忘记密码:拿恢复码重置。整件事的前提是登不上,所以这条路不需要 token
  const [mode, setMode] = useState<'login' | 'recover'>('login')
  const [code, setCode] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  // 重置成功后换到的新恢复码:旧的是一次性的,已经用掉了。
  // 不显示的话用户手里那张纸就悄悄过期了,而他要到下一次忘密码时才发现
  const [freshCode, setFreshCode] = useState('')

  const switchMode = (m: 'login' | 'recover') => {
    setMode(m)
    setError('')
    setPassword(''); setCode(''); setNewPw(''); setNewPw2('')
  }

  const handleSubmit = async () => {
    if (!username.trim() || !password) { setError('请填写用户名和密码'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username.trim(), password }),
      })
      const json = await res.json() as any
      if (!json.ok) throw new Error(json.error)
      onLogin(json.data.token, json.data.username)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const handleRecover = async () => {
    // 形态与两次一致都在前端拦:都是打错字的问题,不值得占一次请求,
    // 更不值得占一次限流额度(那道闸只有 5 次)
    if (!isRecoveryCodeShape(code)) { setError('恢复码格式不对（应为 32 位十六进制）'); return }
    if (newPw.length < 6) { setError('新密码至少 6 个字符'); return }
    if (newPw !== newPw2) { setError('两次输入的新密码不一致'); return }
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/auth/recover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, new_password: newPw }),
      })
      const json = await res.json() as any
      if (!json.ok) throw new Error(json.error)
      // 先把新恢复码摆出来让人抄,点了「我记下了」才进应用
      setFreshCode(json.data.recovery_code)
      setPendingLogin({ token: json.data.token, username: json.data.username })
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  const [pendingLogin, setPendingLogin] = useState<{ token: string; username: string } | null>(null)

  return (
    <div className="min-h-screen bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-lg max-w-md w-full p-8">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 bg-emerald-500 rounded-2xl mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-gray-900">CFNote</h1>
          <p className="text-gray-500 mt-1">{mode === 'login' ? '私人知识库' : '用恢复码重置密码'}</p>
        </div>

        {jwtMissing && (
          <div className="mb-4 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
            服务端未配置 <b>JWT_SECRET</b>，登录将会失败。请在 Cloudflare 仪表盘打开当前 Worker 的
            <b> Settings → Variables and Secrets</b>，添加名为 <b>JWT_SECRET</b> 的变量（类型选
            <b> Secret</b>，值为任意随机字符串），保存后刷新本页面。
          </div>
        )}

        {/* 重置成功:先把新恢复码交出去再放行。旧码已经用掉了(一次性),
            这里不摆出来的话用户手里那张纸就悄悄过期了 */}
        {freshCode && pendingLogin ? (
          <div className="space-y-4">
            <div className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-3">
              密码已重置，其他设备上的登录已全部失效。
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">你的新恢复码</label>
              <code className="block w-full text-center font-mono text-sm bg-gray-50 border border-gray-200 rounded-lg px-3 py-3 tracking-wider select-all break-all">
                {formatRecoveryCode(freshCode)}
              </code>
              <p className="text-[11px] text-amber-700 bg-amber-50 rounded-lg px-2.5 py-1.5 mt-2 leading-relaxed">
                ⚠️ 刚才那个已经用掉了。<b>请把这一个抄下来收好</b>——它是你下次忘记密码时唯一的自助出路。
                以后随时可以在「设置 → 账号」里查看或换一个。
              </p>
            </div>
            <button
              onClick={() => onLogin(pendingLogin.token, pendingLogin.username)}
              className="w-full bg-emerald-500 text-white rounded-lg px-4 py-3 font-medium hover:bg-emerald-600 transition-colors"
            >
              我记下了，进入
            </button>
          </div>
        ) : mode === 'login' ? (
          <>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              <button
                onClick={handleSubmit}
                disabled={loading}
                className="w-full bg-emerald-500 text-white rounded-lg px-4 py-3 font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors"
              >
                {loading ? '登录中...' : '登 录'}
              </button>
            </div>
            <button
              onClick={() => switchMode('recover')}
              className="mt-4 w-full text-center text-sm text-gray-400 hover:text-emerald-600 transition-colors"
            >
              忘记密码？
            </button>
          </>
        ) : (
          <>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">恢复码</label>
                <input
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="a3f9c1e0-8b7d4526-…"
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full font-mono text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
                <p className="text-[11px] text-gray-400 mt-1 leading-relaxed">
                  注册时给过你，也可以在还能登录的设备上从「设置 → 账号」里看到。
                  连字符和大小写都不影响。
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">新密码</label>
                <input
                  type="password"
                  value={newPw}
                  onChange={(e) => setNewPw(e.target.value)}
                  autoComplete="new-password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">再输一次新密码</label>
                <input
                  type="password"
                  value={newPw2}
                  onChange={(e) => setNewPw2(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleRecover()}
                  autoComplete="new-password"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent"
                />
              </div>
              <button
                onClick={handleRecover}
                disabled={loading}
                className="w-full bg-emerald-500 text-white rounded-lg px-4 py-3 font-medium hover:bg-emerald-600 disabled:opacity-50 transition-colors"
              >
                {loading ? '重置中...' : '重置密码'}
              </button>
            </div>
            <p className="text-[11px] text-gray-400 mt-3 text-center leading-relaxed">
              重置会让<b>所有设备上的登录立刻失效</b>，恢复码本身也会换成新的一个。
            </p>
            <button
              onClick={() => switchMode('login')}
              className="mt-3 w-full text-center text-sm text-gray-400 hover:text-emerald-600 transition-colors"
            >
              ← 回到登录
            </button>
          </>
        )}

        {error && (
          <p className="mt-4 text-sm text-red-600 text-center bg-red-50 rounded-lg p-2">{error}</p>
        )}
      </div>
    </div>
  )
}
