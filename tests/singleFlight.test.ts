import { describe, it, expect, vi } from 'vitest'
import { createSingleFlight } from '../src/lib/singleFlight'

/** 手动控制落定时机的 Promise,用来把「在途」这段窗口停住 */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('createSingleFlight', () => {
  it('同一个 key 在途时后来者复用同一个 Promise,fn 只执行一次', async () => {
    const sf = createSingleFlight<number, string>()
    const d = deferred<string>()
    const fn = vi.fn(() => d.promise)

    const a = sf.run(-1, fn)
    const b = sf.run(-1, fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sf.has(-1)).toBe(true)
    expect(sf.size()).toBe(1)

    d.resolve('article-12')
    expect(await a).toBe('article-12')
    expect(await b).toBe('article-12')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('三个调用者撞进同一个窗口,服务端只被打一次,三边拿到同一个对象', async () => {
    // 这条就是 P15.3 的回归用例:Ctrl+S、3 秒自动保存、点「公开」同时落在
    // 「草稿的 POST 还没回来」这段里,以前每一次都会 INSERT 一行
    const sf = createSingleFlight<number, { id: number }>()
    const gate = deferred<void>()
    let created = 0
    const create = async () => {
      await gate.promise
      created += 1
      return { id: 12 }
    }

    const all = Promise.all([sf.run(-1, create), sf.run(-1, create), sf.run(-1, create)])
    gate.resolve()
    const [a, b, c] = await all

    expect(created).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('在途调用结束后闸门释放,下一次真的会再执行', async () => {
    const sf = createSingleFlight<number, number>()
    const fn = vi.fn(async () => 1)

    await sf.run(-1, fn)
    expect(sf.size()).toBe(0)
    await sf.run(-1, fn)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('不同 key 互不干扰', async () => {
    const sf = createSingleFlight<number, string>()
    const d1 = deferred<string>()
    const d2 = deferred<string>()
    const fn1 = vi.fn(() => d1.promise)
    const fn2 = vi.fn(() => d2.promise)

    const a = sf.run(-1, fn1)
    const b = sf.run(-2, fn2)
    expect(sf.size()).toBe(2)

    d1.resolve('一')
    d2.resolve('二')
    expect(await a).toBe('一')
    expect(await b).toBe('二')
  })

  it('失败后 key 会释放,允许重试', async () => {
    // 不释放的话,一次网络抖动就再也存不进去了 —— 比多存一份还糟
    const sf = createSingleFlight<string, string>()
    const bad = vi.fn(() => Promise.reject(new Error('网络请求失败或超时')))

    await expect(sf.run('draft', bad)).rejects.toThrow('网络请求失败或超时')
    expect(sf.has('draft')).toBe(false)

    expect(await sf.run('draft', async () => 'ok')).toBe('ok')
  })

  it('fn 同步抛出时不会把 key 卡死', async () => {
    const sf = createSingleFlight<string, string>()

    await expect(sf.run('draft', () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(sf.has('draft')).toBe(false)

    expect(await sf.run('draft', async () => 'ok')).toBe('ok')
  })

  it('返回 ok:false 的结果算正常落定,同样释放闸门', async () => {
    // useApi 把网络错误也包成 { ok:false },不会 reject —— 这条确保那条路径也能重试
    const sf = createSingleFlight<number, { ok: boolean; error?: string }>()

    const res = await sf.run(-1, async () => ({ ok: false, error: '未选择笔记本' }))
    expect(res.ok).toBe(false)
    expect(sf.size()).toBe(0)

    expect((await sf.run(-1, async () => ({ ok: true }))).ok).toBe(true)
  })
})
