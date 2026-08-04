import { describe, it, expect } from 'vitest'
import { parseWindow, serializeWindow, verdict, bump } from '../src/lib/rateLimit'
import type { RateRule } from '../src/lib/rateLimit'

// P16.6 计数式限流的纯逻辑。
// 这份文件盯的是两件「不测就一定会写错」的事:窗口边界,以及解析失败倒向哪一边。

const RULE: RateRule = { max: 3, windowSec: 60 }

describe('parseWindow(坏数据一律当没有记录)', () => {
  it('正常记录读得回来', () => {
    expect(parseWindow('{"n":2,"start":1000}')).toEqual({ n: 2, start: 1000 })
  })

  it('空/非 JSON/非对象 → null', () => {
    expect(parseWindow(null)).toBeNull()
    expect(parseWindow('')).toBeNull()
    expect(parseWindow('不是 json')).toBeNull()
    expect(parseWindow('null')).toBeNull()
  })

  it('n 不是有限数 → null,而不是拿着 NaN 往下走', () => {
    // NaN >= max 恒为 false,不在这里挡掉的话限流会静默失效而且不报任何错
    expect(parseWindow('{"n":"abc","start":1000}')).toBeNull()
    expect(parseWindow('{"start":1000}')).toBeNull()
    expect(parseWindow('{"n":null,"start":1000}')).toBeNull()
  })

  it('负数 → null(只可能来自被改过的记录)', () => {
    expect(parseWindow('{"n":-5,"start":1000}')).toBeNull()
    expect(parseWindow('{"n":1,"start":-1}')).toBeNull()
  })

  it('序列化能往返', () => {
    expect(parseWindow(serializeWindow({ n: 7, start: 42 }))).toEqual({ n: 7, start: 42 })
  })
})

describe('verdict(只读判断)', () => {
  it('没有记录 → 放行', () => {
    expect(verdict(null, 1000, RULE)).toMatchObject({ limited: false, count: 0 })
  })

  it('没到上限 → 放行', () => {
    expect(verdict({ n: 2, start: 1000 }, 1010, RULE)).toMatchObject({ limited: false, count: 2 })
  })

  it('到上限 → 拦,并给出还要等多久', () => {
    const v = verdict({ n: 3, start: 1000 }, 1010, RULE)
    expect(v.limited).toBe(true)
    expect(v.retryAfter).toBe(50) // 1000 + 60 - 1010
  })

  it('超过上限也照样拦(记录被写花了也不能放过去)', () => {
    expect(verdict({ n: 99, start: 1000 }, 1010, RULE).limited).toBe(true)
  })

  it('窗口整秒到期那一刻就已经属于下一个窗口', () => {
    expect(verdict({ n: 3, start: 1000 }, 1059, RULE).limited).toBe(true)
    expect(verdict({ n: 3, start: 1000 }, 1060, RULE).limited).toBe(false)
  })

  it('retryAfter 不会返回 0(拿到 0 的客户端会立刻重试)', () => {
    // 整数入参下窗口最后一秒是 1059 → 1;下面这条防的是记录里的 start 比当前时刻还新
    // (改过库、或两台机器时钟不齐),那时差值会算成负数
    expect(verdict({ n: 3, start: 1000 }, 1059, RULE).retryAfter).toBe(1)
    expect(verdict({ n: 3, start: 2000 }, 1000, RULE).retryAfter).toBeGreaterThanOrEqual(1)
  })
})

describe('bump(计一次)', () => {
  it('第一次:开新窗口,ttl 等于整个窗口长', () => {
    expect(bump(null, 1000, RULE)).toEqual({ window: { n: 1, start: 1000 }, ttl: 60 })
  })

  it('窗口内累加,起点不动', () => {
    expect(bump({ n: 1, start: 1000 }, 1030, RULE).window).toEqual({ n: 2, start: 1000 })
  })

  it('窗口不因为多记一次而顺延', () => {
    // 顺延就成了滑动窗口:一个一直在敲的攻击者会把自己永久锁住,
    // 而同一个出口 IP 后面可能就坐着知识库的主人
    const a = bump({ n: 1, start: 1000 }, 1030, RULE)
    expect(a.window.start).toBe(1000)
    expect(a.ttl).toBe(30) // 剩余窗口,不是又一个 60
  })

  it('过期后重新开窗,计数清零', () => {
    expect(bump({ n: 3, start: 1000 }, 1060, RULE).window).toEqual({ n: 1, start: 1060 })
  })

  it('连打到上限:第 max 次之后 verdict 才转为拦', () => {
    let w = null as null | { n: number; start: number }
    for (let i = 0; i < RULE.max; i++) {
      expect(verdict(w, 1000, RULE).limited).toBe(false) // 拦之前都还放行
      w = bump(w, 1000, RULE).window
    }
    expect(verdict(w, 1000, RULE).limited).toBe(true)
  })
})
