import { Hono } from 'hono'
import { ok, err, hashPassword, generateSalt, createJWT } from '../utils'
import { rateCheck, rateBump, rateReset, nowSec } from '../rateLimit'
import type { RateRule } from '../../src/lib/rateLimit'
import type { AppEnv } from '../types'
import type { User } from '../../src/types'

export const auth = new Hono<AppEnv>()

/**
 * 登录限流(P16.6):每 IP 每 15 分钟 8 次失败。
 *
 * 8 次:够手滑、够试完记忆里那两三个常用口令,离在线爆破差着好几个数量级。
 * 判断放在**校验口令之前**,超限直接 429 —— 省下的不是 D1 而是 CPU:
 * 每次密码校验是 10 万轮 PBKDF2,不拦的话攻击者一行 curl 循环就能把 Worker 的
 * CPU 时间和「请求数 10 万/天」这个最紧的额度一起烧掉,而他连密码都不用猜对。
 */
const LOGIN_RULE: RateRule = { max: 8, windowSec: 15 * 60 }
const LOGIN_SCOPE = 'login'

// POST /api/auth/register
auth.post('/register', async (c) => {
  try {
    const { username, password } = await c.req.json<{ username: string; password: string }>()
    if (!username || !password) return err('用户名和密码不能为空')
    if (username.length < 2 || username.length > 32) return err('用户名长度应为2-32个字符')
    if (password.length < 6) return err('密码至少6个字符')

    // Check if any user already exists (single-user system)
    const existing = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first<{ count: number }>()
    if (existing && existing.count > 0) {
      return err('系统已有用户，不允许再次注册', 403)
    }

    const salt = generateSalt()
    const hash = await hashPassword(password, salt)
    await c.env.DB.prepare('INSERT INTO users (username, password_hash, salt) VALUES (?, ?, ?)')
      .bind(username, hash, salt)
      .run()

    return ok({ message: '注册成功' })
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return err('用户名已存在')
    return err('注册失败: ' + e.message, 500)
  }
})

// POST /api/auth/login
auth.post('/login', async (c) => {
  try {
    const { username, password } = await c.req.json<{ username: string; password: string }>()
    if (!username || !password) return err('用户名和密码不能为空')

    const ip = c.req.header('cf-connecting-ip') || ''
    const now = nowSec()
    const rl = await rateCheck(LOGIN_SCOPE, ip, LOGIN_RULE, now)
    if (rl.limited) {
      return err(`登录尝试过于频繁,请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`, 429, {
        'Retry-After': String(rl.retryAfter),
      })
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(username)
      .first<User>()

    // 用户不存在时也照样算一遍哈希再返回同一句错误。
    // 不这么做的话两条路径差着 10 万轮 PBKDF2 的耗时,从响应时间就能读出「用户名对不对」,
    // 而枚举出用户名正是爆破的第一步。盐用固定的假盐 —— 只要迭代次数一致,耗时就一致。
    const salt = user?.salt || 'cfnote-no-such-user'
    const hash = await hashPassword(password, salt)
    if (!user || hash !== user.password_hash) {
      await rateBump(LOGIN_SCOPE, ip, LOGIN_RULE, now)
      return err('用户名或密码错误', 401)
    }

    const token = await createJWT({ uid: user.id, username: user.username }, c.env.JWT_SECRET)
    // 手滑几次再输对,不该给后面留个半满的窗口
    await rateReset(LOGIN_SCOPE, ip)

    return ok({ token, username: user.username })
  } catch (e: any) {
    return err('登录失败: ' + e.message, 500)
  }
})
