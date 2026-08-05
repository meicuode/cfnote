import { env } from 'cloudflare:test'
import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, newNotebook, dropAll } from './_helpers'
import { getUserLoose } from '../../worker/utils'

// 改密码与 token 吊销(P16.9)的端到端。
//
// 这批之前根本没有改密码接口,而 token 有 7 天有效期、服务端不存状态——
// 「我怀疑 token 泄露了」这件事无法处理,你能做的只有等它过期。

/** 拿一个当前有效的 token 打一个需要登录的接口,看还认不认 */
async function stillWorks(token: string): Promise<boolean> {
  const res = await api('/api/notebooks', { token })
  return res.status === 200
}

describe('改密码与 token 吊销(P16.9)', () => {
  beforeEach(dropAll)

  it('改完密码,旧 token 立刻失效', async () => {
    // 这是整批的正题。此前旧 token 会一直活到 7 天有效期结束
    const old = await bootstrap('tester', 'old-password')
    expect(await stillWorks(old)).toBe(true)

    const res = await api<{ token: string }>('/api/auth/password', {
      method: 'POST', token: old,
      body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })
    expect(res.body.ok, res.body.error).toBe(true)

    expect(await stillWorks(old)).toBe(false)
  })

  it('改密码会直接返回一张新 token,不必重新登录', async () => {
    // 不给的话用户改完密码,自己手里那张也失效了,表现是「改密码成功,
    // 然后整个界面开始报未登录」——正确但难看,而且会让人以为改坏了
    const old = await bootstrap('tester', 'old-password')
    const res = await api<{ token: string; username: string }>('/api/auth/password', {
      method: 'POST', token: old,
      body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })
    expect(res.body.data!.token).toBeTruthy()
    expect(res.body.data!.token).not.toBe(old)
    expect(await stillWorks(res.body.data!.token)).toBe(true)
  })

  it('新密码能登录,旧密码不能', async () => {
    const old = await bootstrap('tester', 'old-password')
    await api('/api/auth/password', {
      method: 'POST', token: old,
      body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })

    const bad = await api('/api/auth/login', {
      method: 'POST', body: j({ username: 'tester', password: 'old-password' }),
    })
    expect(bad.status).toBe(401)

    const good = await api<{ token: string }>('/api/auth/login', {
      method: 'POST', body: j({ username: 'tester', password: 'new-password' }),
    })
    expect(good.body.ok, good.body.error).toBe(true)
    expect(await stillWorks(good.body.data!.token)).toBe(true)
  })

  it('旧密码不对就拒绝——已登录也不行', async () => {
    // token 被别人拿到时,「改掉密码把主人锁在外面」不该是一步就能做到的事
    const token = await bootstrap('tester', 'old-password')
    const res = await api('/api/auth/password', {
      method: 'POST', token,
      body: j({ old_password: '猜的', new_password: 'new-password' }),
    })
    // 400 而不是 401:会话是有效的,错的是请求体里的一个字段。
    // 前端 useApi 把所有 401 统一改写成「未登录或登录已过期」,用 401 的话
    // 打错一个字会看到「登录已过期」,而他明明登录着
    expect(res.status).toBe(400)
    expect(res.body.error).toContain('旧密码')
    // 没改成,原 token 照常能用
    expect(await stillWorks(token)).toBe(true)
  })

  it('没登录不能改密码', async () => {
    await bootstrap('tester', 'old-password')
    const res = await api('/api/auth/password', {
      method: 'POST',
      body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })
    expect(res.status).toBe(401)
  })

  it('新密码太短、与旧密码相同,都要挡住', async () => {
    const token = await bootstrap('tester', 'old-password')
    const short = await api('/api/auth/password', {
      method: 'POST', token, body: j({ old_password: 'old-password', new_password: '123' }),
    })
    expect(short.status).toBe(400)
    const same = await api('/api/auth/password', {
      method: 'POST', token, body: j({ old_password: 'old-password', new_password: 'old-password' }),
    })
    expect(same.status).toBe(400)
  })

  it('改密码换了 salt——旧密码的哈希不再匹配,与 epoch 是两道各自独立的闸', async () => {
    const token = await bootstrap('tester', 'old-password')
    const before = await env.DB.prepare('SELECT salt, token_epoch FROM users WHERE username = ?')
      .bind('tester').first<{ salt: string; token_epoch: number }>()
    await api('/api/auth/password', {
      method: 'POST', token, body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })
    const after = await env.DB.prepare('SELECT salt, token_epoch FROM users WHERE username = ?')
      .bind('tester').first<{ salt: string; token_epoch: number }>()
    expect(after!.salt).not.toBe(before!.salt)
    expect(after!.token_epoch).toBe((before!.token_epoch ?? 0) + 1)
  })

  it('cookie 那条路(getUserLoose)也要过 epoch', async () => {
    // 漏了它,改完密码旧 token 仍能靠 cookie 读到全部附件——
    // 而附件里正是截图、扫描件这类最私密的东西。
    //
    // 不走 HTTP:getUserLoose 只用在附件路由上,而那条路由在取用户之前就要求 R2 绑定,
    // 测试环境刻意不声明 BUCKET(见 docs/verify.md 的「真绑定」一类)。
    // 所以直接调这个函数——要验的本来就是「cookie 这条分支有没有过 epoch」,
    // 不是附件路由的其余部分
    const old = await bootstrap('tester', 'old-password')
    const withCookie = new Request('https://cfnote.test/api/afile/1', {
      headers: { Cookie: `cfnote_t=${old}` },
    })
    expect(await getUserLoose(withCookie, env)).not.toBeNull()

    await api('/api/auth/password', {
      method: 'POST', token: old,
      body: j({ old_password: 'old-password', new_password: 'new-password' }),
    })
    // 同一个请求对象、同一张 cookie,改完密码之后必须不认了
    expect(await getUserLoose(withCookie, env)).toBeNull()
  })

  it('多次改密码,epoch 逐次递增,每一代都只有最新那张能用', async () => {
    let token = await bootstrap('tester', 'pass-000')
    for (let i = 1; i <= 3; i++) {
      const prev = token
      const res = await api<{ token: string }>('/api/auth/password', {
        method: 'POST', token: prev,
        body: j({ old_password: `pass-${String(i - 1).padStart(3, '0')}`, new_password: `pass-${String(i).padStart(3, '0')}` }),
      })
      expect(res.body.ok, res.body.error).toBe(true)
      token = res.body.data!.token
      expect(await stillWorks(prev)).toBe(false)
      expect(await stillWorks(token)).toBe(true)
    }
    const row = await env.DB.prepare('SELECT token_epoch FROM users WHERE username = ?')
      .bind('tester').first<{ token_epoch: number }>()
    expect(row!.token_epoch).toBe(3)
  })

  it('老 token(没有 epoch 字段)与老库(token_epoch 为 NULL)仍然认', async () => {
    // 这一批上线不该把已经登录的人全踢出去。老 token 里读出来是 undefined,
    // 老库里是 NULL,两边都归一到 0 后相等——所以不必为老 token 另写兼容分支
    const token = await bootstrap('tester', 'old-password')
    await env.DB.prepare('UPDATE users SET token_epoch = NULL WHERE username = ?').bind('tester').run()
    expect(await stillWorks(token)).toBe(true)
  })

  it('用户被删掉后,他的 token 不该还能用', async () => {
    const token = await bootstrap('tester', 'old-password')
    await newNotebook(token, '留下的笔记本')
    await env.DB.prepare('DELETE FROM users WHERE username = ?').bind('tester').run()
    expect(await stillWorks(token)).toBe(false)
  })
})
