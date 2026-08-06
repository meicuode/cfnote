import { Hono } from 'hono'
import { ok, err, hashPassword, generateSalt, generateRecoveryCode, createJWT } from '../utils'
import { rateCheck, rateBump, rateReset, nowSec } from '../rateLimit'
import { recoveryCodeMatches, isRecoveryCodeShape } from '../../src/lib/recoveryCode'
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

/**
 * 恢复码限流(P17.2)。比登录更紧:8 次是给「手滑 + 试记忆里那两三个口令」留的余地,
 * 而恢复码从来不是记的,是复制粘贴的——粘错 5 次已经很多了。
 *
 * **不做「错 N 次作废」**:那会变成一个永久锁死向量——攻击者随手猜 5 次就能把
 * 你唯一的兑回路径弄废,而你正处在「忘了密码」的状态,只能回去改 D1。
 * 这个方向的失败伤主人、拦不住攻击者,和 P16.6 限流 fail open 是同一条论证。
 * 「3 次作废」那套规矩来自 6 位短信验证码(10^6 的空间,不限次就真能穷举),
 * 而这个码是 128 bit —— 熵本身就是防线,限次只剩副作用。
 */
const RECOVER_RULE: RateRule = { max: 5, windowSec: 15 * 60 }
const RECOVER_SCOPE = 'recover'

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
    // 注册当场就给恢复码(P17.2)。不在这里给的话,唯一的时机就只剩「用户某天
    // 主动逛到设置里」——而那时候他还不知道有这个东西,更不会知道要抄下来
    const recovery = generateRecoveryCode()
    await c.env.DB.prepare('INSERT INTO users (username, password_hash, salt, recovery_code) VALUES (?, ?, ?, ?)')
      .bind(username, hash, salt, recovery)
      .run()

    return ok({ message: '注册成功', recovery_code: recovery })
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

    const token = await createJWT(
      { uid: user.id, username: user.username, epoch: user.token_epoch ?? 0 },
      c.env.JWT_SECRET,
    )
    // 手滑几次再输对,不该给后面留个半满的窗口
    await rateReset(LOGIN_SCOPE, ip)

    return ok({ token, username: user.username })
  } catch (e: any) {
    return err('登录失败: ' + e.message, 500)
  }
})

// POST /api/auth/password {old_password, new_password} - 改密码,并吊销所有旧 token(P16.9)
//
// 在此之前根本没有改密码这个接口:密码是 /api/init 之后注册时定下的,想换只能去改数据库。
// 而 token 有 7 天有效期、服务端不存状态,于是「我怀疑 token 泄露了」这件事无法处理——
// 你能做的只有等它过期。
//
// 吊销靠 users.token_epoch:签发时写进 token,鉴权时比对,这里 +1 就让全部旧 token 当场失效。
// **换密码必然换 salt**,所以旧密码算出来的哈希也不再匹配——两道各自独立。
auth.post('/password', async (c) => {
  const me = c.get('user')
  try {
    const { old_password, new_password } = await c.req.json<{ old_password: string; new_password: string }>()
    if (!old_password || !new_password) return err('旧密码和新密码都不能为空')
    if (new_password.length < 6) return err('新密码至少6个字符')
    if (old_password === new_password) return err('新密码不能与旧密码相同')

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first<User>()
    if (!user) return err('用户不存在', 404)

    // 已登录才能走到这里,但仍然要验旧密码:token 被别人拿到时,
    // 「改掉密码把主人锁在外面」不该是一步就能做到的事。
    //
    // 旧密码不对返回 **400 而不是 401**:走到这个 handler 说明中间件已经认过 token,
    // 会话是有效的,错的是请求体里的一个字段。而且前端 useApi 把所有 401 统一改写成
    // 「未登录或登录已过期」——用 401 的话,用户打错一个字会看到「登录已过期」,
    // 而他明明登录着。同一个状态码在一个接口上表达两件事,客户端就分不开了。
    const oldHash = await hashPassword(old_password, user.salt)
    if (oldHash !== user.password_hash) return err('旧密码不正确')

    const salt = generateSalt()
    const hash = await hashPassword(new_password, salt)
    const epoch = (user.token_epoch ?? 0) + 1
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, salt = ?, token_epoch = ? WHERE id = ?'
    ).bind(hash, salt, epoch, me.id).run()

    // 立刻签一张新 token 一并返回:不给的话用户改完密码,自己手里这张也失效了,
    // 表现是「改密码成功,然后整个界面开始报未登录」——正确但难看,而且会让人以为改坏了
    const token = await createJWT({ uid: user.id, username: user.username, epoch }, c.env.JWT_SECRET)
    return ok({ token, username: user.username })
  } catch (e: any) {
    return err('修改密码失败: ' + e.message, 500)
  }
})

// ---- 恢复码(P17.2)----

// GET /api/auth/recovery-code - 看当前这一个(需登录)
//
// 明文返回,和 API Key 那套「只显示后四位」相反——那些是**给机器用的凭据**,
// 显示全文没有意义;而这个码的用途就是让人抄下来,遮起来就等于没有。
auth.get('/recovery-code', async (c) => {
  const me = c.get('user')
  const row = await c.env.DB.prepare('SELECT recovery_code FROM users WHERE id = ?')
    .bind(me.id).first<{ recovery_code: string | null }>()
  return ok({ recovery_code: row?.recovery_code || '' })
})

// POST /api/auth/recovery-code - 重新生成(需登录)
//
// 旧的当场作废。抄错了、抄丢了、或者怀疑抄在了不该抄的地方,都靠这个换一张。
auth.post('/recovery-code', async (c) => {
  const me = c.get('user')
  const recovery = generateRecoveryCode()
  await c.env.DB.prepare('UPDATE users SET recovery_code = ? WHERE id = ?').bind(recovery, me.id).run()
  return ok({ recovery_code: recovery })
})

// POST /api/auth/recover {code, new_password} - 拿恢复码重置密码(**公开接口**)
//
// 这是整批的正题:登出了 + 忘了密码 = 此前完全无解,只能去 Cloudflare 控制台
// 删 users 那一行重注册(还得记得清 sqlite_sequence,否则笔记会「消失」)。
//
// 不要用户名:单用户系统里用户名不是秘密(登录页那个框就摆在那儿),
// 多要一个字段只是多一个能填错的地方,挡不住任何人。
auth.post('/recover', async (c) => {
  try {
    const { code, new_password } = await c.req.json<{ code: string; new_password: string }>()
    if (!code || !new_password) return err('恢复码和新密码都不能为空')
    if (new_password.length < 6) return err('新密码至少6个字符')

    const ip = c.req.header('cf-connecting-ip') || ''
    const now = nowSec()
    const rl = await rateCheck(RECOVER_SCOPE, ip, RECOVER_RULE, now)
    if (rl.limited) {
      return err(`尝试过于频繁,请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`, 429, {
        'Retry-After': String(rl.retryAfter),
      })
    }
    // 形态不对(长度/字符集)连查库都不必。这不是安全判断,是省掉一次 D1 往返——
    // 真正的比较在 recoveryCodeMatches 里,常数时间
    if (!isRecoveryCodeShape(code)) {
      await rateBump(RECOVER_SCOPE, ip, RECOVER_RULE, now)
      return err('恢复码不正确', 401)
    }

    const user = await c.env.DB.prepare('SELECT * FROM users ORDER BY id LIMIT 1').first<User>()
    if (!user || !recoveryCodeMatches(code, user.recovery_code)) {
      await rateBump(RECOVER_SCOPE, ip, RECOVER_RULE, now)
      return err('恢复码不正确', 401)
    }

    // 一次性:用掉就换一张。用过的凭据不该继续有效——万一它是从某张旧截图、
    // 旧笔记里泄出来的,重置完还留着就等于那条路一直开着
    const salt = generateSalt()
    const hash = await hashPassword(new_password, salt)
    const epoch = (user.token_epoch ?? 0) + 1
    const recovery = generateRecoveryCode()
    await c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, salt = ?, token_epoch = ?, recovery_code = ? WHERE id = ?'
    ).bind(hash, salt, epoch, recovery, user.id).run()

    // epoch +1 顺带把所有设备踢下线(复用 P16.9)。走到这条路上说明密码可能已经
    // 不受控了,那么「别的地方还登着」这件事本身就是要清理的对象
    await rateReset(RECOVER_SCOPE, ip)
    const token = await createJWT({ uid: user.id, username: user.username, epoch }, c.env.JWT_SECRET)
    return ok({ token, username: user.username, recovery_code: recovery })
  } catch (e: any) {
    return err('重置密码失败: ' + e.message, 500)
  }
})
