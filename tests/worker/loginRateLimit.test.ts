import { describe, it, expect, beforeEach } from 'vitest'
import { api, j, bootstrap, dropAll } from './_helpers'
import { rateBump, nowSec } from '../../worker/rateLimit'
import type { RateRule } from '../../src/lib/rateLimit'

// P16.6 登录限流的端到端。
// 纯函数那份(tests/rateLimit.test.ts)管窗口与解析,这份只管一件纯函数看不见的事:
// **限流判断确实排在密码校验之前**——超限时那次 10 万轮 PBKDF2 一次都不该发生。
//
// 为什么不用「连打 8 次真实登录」把窗口填满:那是每个用例 8 轮 PBKDF2 × 10 万次迭代,
// 单跑这个文件很快,但 npm test 里 unit 与 worker 两个 project 是并行的,
// 这点 CPU 一抢,隔壁文件就集体撞上 5 秒默认超时——第一次跑出来正是这个现象
// (worker 单独跑 84 个用例全绿,全量跑挂 4 个,其中 3 个在我根本没碰的文件里)。
// 改成直接调 rateBump 预置计数,只留**一次**真实登录来验证 429。测的东西一点没少:
// 填窗口本来就不是被测对象,被测的是「拦不拦、拦在哪一步」。

beforeEach(dropAll)

// 必须与 worker/routes/auth.ts 里的 LOGIN_RULE 一致
const RULE: RateRule = { max: 8, windowSec: 15 * 60 }

const login = (username: string, password: string, ip?: string) =>
  api<{ token: string }>('/api/auth/login', {
    method: 'POST',
    body: j({ username, password }),
    headers: ip ? { 'CF-Connecting-IP': ip } : undefined,
  })

/** 把某个 IP 的失败计数直接顶到上限,不走真实登录(省掉 n 轮 PBKDF2) */
const fillWindow = async (ip: string, times = RULE.max) => {
  const now = nowSec()
  for (let i = 0; i < times; i++) await rateBump('login', ip, RULE, now)
}

describe('登录限流(P16.6)', () => {
  it('前提:这个测试环境里 Cache API 真的存得住东西', async () => {
    // 限流的存储是 caches.default。若测试池里它是个空壳,下面所有断言都会退化成
    // 「限流没生效也照样绿」——先把前提本身断言掉,免得给出虚假的通过
    const cache = (caches as unknown as { default: Cache }).default
    const key = new Request('https://ratelimit-probe.cfnote.internal/x')
    await cache.put(key, new Response('7', { headers: { 'Cache-Control': 'public, max-age=60' } }))
    expect(await (await cache.match(key))?.text()).toBe('7')
  })

  it('达到上限后返回 429', async () => {
    await bootstrap()
    const ip = '203.0.113.1'
    await fillWindow(ip)
    const blocked = await login('tester', '错的口令', ip)
    expect(blocked.status).toBe(429)
    expect(blocked.body.error).toContain('频繁')
  })

  it('差一次到上限时仍然放行(不是把整个 IP 一棍子打死)', async () => {
    await bootstrap()
    const ip = '203.0.113.8'
    await fillWindow(ip, RULE.max - 1)
    expect((await login('tester', '错的口令', ip)).status).toBe(401)
  })

  it('超限之后连**正确**的口令也一起挡住(说明拦在校验之前)', async () => {
    await bootstrap()
    const ip = '203.0.113.2'
    await fillWindow(ip)
    const right = await login('tester', 'test-password', ip)
    expect(right.status).toBe(429)
    expect(right.body.data?.token).toBeUndefined()
  })

  it('真实的失败登录会计数(rateBump 确实挂在失败分支上)', async () => {
    // 上面几条都是预置计数,万一 auth.ts 忘了调 rateBump 也照样绿。
    // 这条补上那个缺口:填到 max-1,再用一次**真实**失败凑满,然后应当被拦
    await bootstrap()
    const ip = '203.0.113.9'
    await fillWindow(ip, RULE.max - 1)
    expect((await login('tester', '错的口令', ip)).status).toBe(401)
    expect((await login('tester', '错的口令', ip)).status).toBe(429)
  })

  it('换一个 IP 不受影响(计数按 IP 分桶,不是全局开关)', async () => {
    await bootstrap()
    await fillWindow('203.0.113.3')
    expect((await login('tester', '错的口令', '203.0.113.3')).status).toBe(429)

    const other = await login('tester', 'test-password', '203.0.113.4')
    expect(other.status).toBe(200)
    expect(other.body.data?.token).toBeTruthy()
  })

  it('成功登录清账:手滑几次再输对,后面不留半满的窗口', async () => {
    await bootstrap()
    const ip = '203.0.113.5'
    await fillWindow(ip, RULE.max - 1)
    expect((await login('tester', 'test-password', ip)).status).toBe(200)
    // 清了账,所以刚才那 7 次不算数:再填 max-1 次仍然放行
    await fillWindow(ip, RULE.max - 1)
    expect((await login('tester', '错的口令', ip)).status).toBe(401)
  })

  it('用户不存在与口令错误返回同一句话、同一个状态码(不泄露用户名是否存在)', async () => {
    await bootstrap()
    const noUser = await login('查无此人', '随便', '203.0.113.6')
    const wrongPw = await login('tester', '错的口令', '203.0.113.7')
    expect(noUser.status).toBe(wrongPw.status)
    expect(noUser.body.error).toBe(wrongPw.body.error)
  })

  it('没有 CF-Connecting-IP 时放行,不至于把人锁在门外', async () => {
    await bootstrap()
    // 本地 dev / 直连 workerd 都没有这个头。降级方向只能是放行:
    // 单用户系统里把主人挡在外面没有第二条补救路径
    for (let i = 0; i < 3; i++) {
      expect((await login('tester', '错的口令')).status).toBe(401)
    }
    expect((await login('tester', 'test-password')).status).toBe(200)
  })
})
