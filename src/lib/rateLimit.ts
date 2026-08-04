/**
 * 计数式限流的纯逻辑(P16.6)。
 *
 * 存储交给调用方(线上是 Cache API,见 `worker/rateLimit.ts`),这里只回答三件事:
 * 拿着旧记录和当前时刻——算不算超限、新记录该写成什么、这条记录还该活多久。
 *
 * 单独拆出来是因为限流写错的地方从来不在存储,而在两处:
 * 窗口边界(过期到底清不清零),以及**解析失败时倒向哪一边**——
 * 计数读回来是 NaN 时 `NaN >= max` 恒为 false,限流会静默失效而不报任何错。
 * 这两件事只有纯函数测得动。
 */

export interface RateRule {
  /** 窗口内允许的次数,达到即拦 */
  max: number
  /** 窗口长度(秒) */
  windowSec: number
}

export interface RateWindow {
  /** 窗口内已计次数 */
  n: number
  /** 窗口起点(epoch 秒) */
  start: number
}

export interface RateVerdict {
  limited: boolean
  /** 窗口内已计次数;窗口已过期算 0 */
  count: number
  /** 还要等多少秒才解封;没超限为 0 */
  retryAfter: number
}

export const OPEN: RateVerdict = { limited: false, count: 0, retryAfter: 0 }

/**
 * 解析存下来的窗口。任何解析不出来的东西一律当「没有记录」。
 * 倒向「没有记录」= 倒向放行:这是限流唯一可接受的降级方向,
 * 单用户系统里把主人锁在门外没有第二条补救路径。
 */
export function parseWindow(raw: string | null | undefined): RateWindow | null {
  if (!raw) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const o = v as { n?: unknown; start?: unknown } | null
  // 必须先验 typeof:Number(null) 是 0 而不是 NaN,Number('') / Number([]) 也是 0。
  // 只靠 Number.isFinite 的话,一条被写坏的记录会被悄悄读成「计数 0 的合法窗口」——
  // 眼下的后果只是失效方向偏放行(等同于没记录),但那是撞对的,不是设计对的
  if (typeof o?.n !== 'number' || typeof o?.start !== 'number') return null
  const { n, start } = o as { n: number; start: number }
  // Number.isFinite 同时挡掉 NaN 与 ±Infinity;负数只可能来自被改过的记录
  if (!Number.isFinite(n) || !Number.isFinite(start) || n < 0 || start < 0) return null
  return { n: Math.floor(n), start: Math.floor(start) }
}

export function serializeWindow(w: RateWindow): string {
  return JSON.stringify({ n: w.n, start: w.start })
}

/** 窗口过期就当没有过。用 >= 而非 >:windowSec 秒整那一刻应当已经属于下一个窗口 */
function live(w: RateWindow | null, now: number, rule: RateRule): RateWindow | null {
  if (!w) return null
  return now - w.start >= rule.windowSec ? null : w
}

/**
 * 只读判断,不改计数。
 * 「先挡住,再决定要不要算密码」靠的就是它不写——登录接口在这一步返回 429,
 * 后面那次 10 万轮 PBKDF2 就一次都不会发生。
 */
export function verdict(w: RateWindow | null, now: number, rule: RateRule): RateVerdict {
  const cur = live(w, now, rule)
  if (!cur) return OPEN
  if (cur.n < rule.max) return { limited: false, count: cur.n, retryAfter: 0 }
  return { limited: true, count: cur.n, retryAfter: Math.max(1, cur.start + rule.windowSec - now) }
}

/**
 * 记一次之后该写回什么、这条记录还该活多久(秒)。
 * 窗口**不因为多记一次而顺延**:顺延就成了滑动窗口,一个一直在敲的攻击者会把自己
 * 永久锁住——听着不亏,但同一个出口 IP 后面可能就是知识库的主人。
 */
export function bump(w: RateWindow | null, now: number, rule: RateRule): { window: RateWindow; ttl: number } {
  const cur = live(w, now, rule)
  const next = cur ? { n: cur.n + 1, start: cur.start } : { n: 1, start: now }
  return { window: next, ttl: Math.max(1, next.start + rule.windowSec - now) }
}
