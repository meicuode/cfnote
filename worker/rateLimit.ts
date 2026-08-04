import { parseWindow, serializeWindow, verdict, bump, OPEN } from '../src/lib/rateLimit'
import type { RateRule } from '../src/lib/rateLimit'

/**
 * 计数式限流的 Cache API 后端(P16.6)。
 *
 * 存储沿用 blog.ts 里浏览计数/评论限流那一套 caches.default:零配额、不占 D1 写额度、
 * 按数据中心(colo)生效。对个人博客量级足够——单个攻击者通常固定走一个 colo,
 * 而分散到多个 colo 的分布式爆破本来就不是这个部署要扛的威胁。
 *
 * 与评论限流的区别是**这里要计数**(评论那条是「有标记就拦」的一次性标记),
 * 因为登录要允许几次手滑。计数放在 body 里,窗口靠 Cache-Control 的 max-age 自然过期。
 *
 * 缓存不可用时(本地 dev、workers.dev 域名)一律放行 —— 这是限流唯一可接受的降级方向,
 * 单用户系统里把主人锁在门外没有第二条补救路径。
 */

function cacheOrNull(): Cache | null {
  try {
    // 类型断言:tsconfig 同时含 DOM lib,caches 解析为 DOM CacheStorage(无 default);运行时是 Workers 的 caches.default
    return (caches as unknown as { default?: Cache }).default ?? null
  } catch {
    return null
  }
}

async function keyOf(scope: string, id: string): Promise<Request> {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(scope + ':' + id))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
  return new Request(`https://ratelimit.cfnote.internal/${scope}/${hex}`)
}

export interface RateState {
  limited: boolean
  count: number
  retryAfter: number
}

/**
 * 只看不记。放在密码校验**之前**:超限时直接 429,那次 10 万轮 PBKDF2 就不会发生。
 * 这才是这条限流真正省下的东西——爆破的时间代价对方付,CPU 时间的代价我付。
 */
export async function rateCheck(scope: string, id: string, rule: RateRule, now: number): Promise<RateState> {
  if (!id) return OPEN
  const cache = cacheOrNull()
  if (!cache) return OPEN
  try {
    const hit = await cache.match(await keyOf(scope, id))
    return verdict(parseWindow(hit ? await hit.text() : null), now, rule)
  } catch {
    return OPEN
  }
}

/** 记一次(失败时才调)。写不进去就算了:限流失效好过登录失效 */
export async function rateBump(scope: string, id: string, rule: RateRule, now: number): Promise<void> {
  if (!id) return
  const cache = cacheOrNull()
  if (!cache) return
  try {
    const key = await keyOf(scope, id)
    const hit = await cache.match(key)
    const { window, ttl } = bump(parseWindow(hit ? await hit.text() : null), now, rule)
    await cache.put(
      key,
      new Response(serializeWindow(window), {
        headers: { 'Cache-Control': `public, max-age=${ttl}`, 'Content-Type': 'application/json' },
      })
    )
  } catch {
    /* 忽略 */
  }
}

/** 成功登录后清账:手滑几次再输对不该给后面留个短窗口 */
export async function rateReset(scope: string, id: string): Promise<void> {
  if (!id) return
  const cache = cacheOrNull()
  if (!cache) return
  try {
    await cache.delete(await keyOf(scope, id))
  } catch {
    /* 忽略 */
  }
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
