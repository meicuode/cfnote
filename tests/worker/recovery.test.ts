import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, newNotebook, dropAll } from './_helpers'
import { formatRecoveryCode, isRecoveryCodeShape } from '../../src/lib/recoveryCode'

// 恢复码(P17.2)的端到端。
//
// 这批之前,「登出了 + 忘了密码」完全无解:改密码要旧密码,注册接口在已有用户时 403,
// 而 password_hash 是 PBKDF2 十万轮——D1 控制台里算不出来,所以「能读库」也不等于
// 「能重置密码」。唯一的路是删掉 users 那一行重新注册,还得同时清 sqlite_sequence,
// 否则新用户拿到 id=2 而笔记全挂在 user_id=1 上,表现是「笔记全没了」。

/** 拿 token 打一个需要登录的接口,看还认不认 */
async function stillWorks(token: string): Promise<boolean> {
  const res = await api('/api/notebooks', { token })
  return res.status === 200
}

/** 取当前恢复码(需登录) */
async function getCode(token: string): Promise<string> {
  const res = await api<{ recovery_code: string }>('/api/auth/recovery-code', { token })
  expect(res.body.ok, res.body.error).toBe(true)
  return res.body.data!.recovery_code
}

describe('恢复码与忘记密码(P17.2)', () => {
  beforeEach(dropAll)

  it('注册就给一个恢复码,形态是 32 位 hex', async () => {
    await api('/api/init', { method: 'POST' })
    const reg = await api<{ recovery_code: string }>('/api/auth/register', {
      method: 'POST', body: j({ username: 'tester', password: 'test-password' }),
    })
    expect(reg.body.ok, reg.body.error).toBe(true)
    // 注册当场就给,不给的话唯一的时机就只剩「某天主动逛到设置里」,
    // 而那时候他还不知道有这个东西
    expect(isRecoveryCodeShape(reg.body.data!.recovery_code)).toBe(true)
  })

  it('拿恢复码能重置密码——这是整批的正题', async () => {
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)

    const res = await api<{ token: string }>('/api/auth/recover', {
      method: 'POST', body: j({ code, new_password: 'new-password' }),
    })
    expect(res.body.ok, res.body.error).toBe(true)

    // 新密码能登,旧的不能
    const good = await api<{ token: string }>('/api/auth/login', {
      method: 'POST', body: j({ username: 'tester', password: 'new-password' }),
    })
    expect(good.body.ok, good.body.error).toBe(true)
    const bad = await api('/api/auth/login', {
      method: 'POST', body: j({ username: 'tester', password: 'old-password' }),
    })
    expect(bad.status).toBe(401)
  })

  it('重置**不需要登录**(整件事的前提就是登不上)', async () => {
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)
    // 不带 token
    const res = await api('/api/auth/recover', {
      method: 'POST', body: j({ code, new_password: 'new-password' }),
    })
    expect(res.status).toBe(200)
    expect(res.body.ok, res.body.error).toBe(true)
  })

  it('重置会踢掉所有设备', async () => {
    // 走到这条路上说明密码可能已经不受控了,「别的地方还登着」正是要清理的对象
    const old = await bootstrap('tester', 'old-password')
    const code = await getCode(old)
    expect(await stillWorks(old)).toBe(true)

    await api('/api/auth/recover', { method: 'POST', body: j({ code, new_password: 'new-password' }) })
    expect(await stillWorks(old)).toBe(false)
  })

  it('重置直接返回一张能用的新 token,不必再登一次', async () => {
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)
    const res = await api<{ token: string }>('/api/auth/recover', {
      method: 'POST', body: j({ code, new_password: 'new-password' }),
    })
    expect(await stillWorks(res.body.data!.token)).toBe(true)
  })

  it('恢复码是一次性的:用掉就换一张,旧的不再认', async () => {
    // 用过的凭据不该继续有效——万一它是从某张旧截图泄出来的,留着就等于那条路一直开着
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)

    const first = await api<{ recovery_code: string }>('/api/auth/recover', {
      method: 'POST', body: j({ code, new_password: 'new-password' }),
    })
    expect(first.body.ok).toBe(true)
    expect(first.body.data!.recovery_code).not.toBe(code)

    // 同一个码再用一次
    const again = await api('/api/auth/recover', {
      method: 'POST', body: j({ code, new_password: 'third-password' }),
    })
    expect(again.status).toBe(401)
    // 没改成,第二次的新密码仍然有效
    const login = await api('/api/auth/login', {
      method: 'POST', body: j({ username: 'tester', password: 'new-password' }),
    })
    expect(login.body.ok).toBe(true)
  })

  it('带连字符的形态也认(设置页显示的就是那个样子)', async () => {
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)
    const res = await api('/api/auth/recover', {
      method: 'POST', body: j({ code: formatRecoveryCode(code), new_password: 'new-password' }),
    })
    expect(res.body.ok, res.body.error).toBe(true)
  })

  it('错的恢复码拒绝,而且不动密码', async () => {
    const token = await bootstrap('tester', 'old-password')
    const res = await api('/api/auth/recover', {
      method: 'POST', body: j({ code: 'f'.repeat(32), new_password: 'new-password' }),
    })
    expect(res.status).toBe(401)
    // 原密码照常
    const login = await api('/api/auth/login', {
      method: 'POST', body: j({ username: 'tester', password: 'old-password' }),
    })
    expect(login.body.ok).toBe(true)
    expect(await stillWorks(token)).toBe(true)
  })

  it('库里没有恢复码(老库)时,空码不能当万能钥匙', async () => {
    // fail open 最坏的一种形态:空 === 空,任何人都能重置密码
    const token = await bootstrap('tester', 'old-password')
    await env.DB.prepare('UPDATE users SET recovery_code = NULL').run()
    for (const code of ['', ' ', '-'.repeat(35), '0'.repeat(32)]) {
      const res = await api('/api/auth/recover', {
        method: 'POST', body: j({ code, new_password: 'new-password' }),
      })
      expect(res.body.ok, `空码 ${JSON.stringify(code)} 竟然通过了`).toBe(false)
    }
    expect(await stillWorks(token)).toBe(true)
  })

  it('新密码太短要挡住', async () => {
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)
    const res = await api('/api/auth/recover', { method: 'POST', body: j({ code, new_password: '123' }) })
    expect(res.status).toBe(400)
    // 挡下来之后恢复码**不该**被消耗掉
    expect(await getCode(token)).toBe(code)
  })

  it('重新生成会换掉旧的,旧码当场作废', async () => {
    const token = await bootstrap('tester', 'old-password')
    const old = await getCode(token)
    const res = await api<{ recovery_code: string }>('/api/auth/recovery-code', { method: 'POST', token })
    expect(res.body.ok, res.body.error).toBe(true)
    const fresh = res.body.data!.recovery_code
    expect(fresh).not.toBe(old)
    expect(await getCode(token)).toBe(fresh)

    const useOld = await api('/api/auth/recover', {
      method: 'POST', body: j({ code: old, new_password: 'new-password' }),
    })
    expect(useOld.status).toBe(401)
  })

  it('看/换恢复码都要登录', async () => {
    await bootstrap('tester', 'old-password')
    expect((await api('/api/auth/recovery-code')).status).toBe(401)
    expect((await api('/api/auth/recovery-code', { method: 'POST' })).status).toBe(401)
  })

  it('改密码(P16.9)不会动恢复码', async () => {
    // 两者是各自独立的凭据:改密码是例行操作,不该顺手让抄在纸上的那张作废
    const token = await bootstrap('tester', 'old-password')
    const code = await getCode(token)
    const res = await api<{ token: string }>('/api/auth/password', {
      method: 'POST', token,
      body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })
    expect(res.body.ok, res.body.error).toBe(true)
    expect(await getCode(res.body.data!.token)).toBe(code)
  })

  it('重置之后数据还在(不是删号重来)', async () => {
    // 此前那条「删 users 重注册」的路,漏清 sqlite_sequence 就会让笔记全部失联。
    // 恢复码这条路根本不动 users 那一行,所以 user_id 恒定
    const token = await bootstrap('tester', 'old-password')
    const nbId = await newNotebook(token, '重置前建的笔记本')
    const code = await getCode(token)

    const res = await api<{ token: string }>('/api/auth/recover', {
      method: 'POST', body: j({ code, new_password: 'new-password' }),
    })
    const list = await api<{ id: number }[]>('/api/notebooks', { token: res.body.data!.token })
    expect(list.body.data!.some((n) => n.id === nbId)).toBe(true)

    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
    expect(row!.n).toBe(1)
  })
})
