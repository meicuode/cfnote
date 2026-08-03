/**
 * 单飞(single-flight):同一个 key 上只允许一个异步调用在途,后来者复用同一个 Promise。
 *
 * 起因是「新建笔记连按保存会多出几篇」(P15.3)。草稿在本地是 id 为负的假记录,
 * 真正的行要等 POST /api/articles 回来、拿到 last_row_id 才存在。在那之前
 * article.id 一直是负数,于是任何第二次保存——3 秒空闲自动保存、再按一次 Ctrl+S、
 * 点「公开」——都会走进「这是草稿,建一篇」的分支再 INSERT 一行。服务端不去重
 * (worker/routes/articles.ts 的 POST / 直接 INSERT),结果就是一篇草稿变成好几篇笔记。
 *
 * 为什么闸门放在这里、而不是各个按钮上:调用方只会越来越多,漏一个就复发;
 * 而「同一篇草稿的创建请求同时只能有一个」是一句和 UI 无关的话,能单独测。
 *
 * 后来者拿到的是同一个 Promise,不是错误、也不是静默丢弃——它会等到同一个请求的
 * 结果,所以调用方完全不需要知道自己被合并了。
 */

export interface SingleFlight<K, T> {
  /** key 上已有在途调用则复用它,否则执行 fn 并登记 */
  run(key: K, fn: () => Promise<T>): Promise<T>
  /** key 上是否有调用在途(只用于测试与调试) */
  has(key: K): boolean
  /** 在途调用数(只用于测试与调试) */
  size(): number
}

export function createSingleFlight<K, T>(): SingleFlight<K, T> {
  const inflight = new Map<K, Promise<T>>()

  return {
    run(key, fn) {
      const running = inflight.get(key)
      if (running) return running

      let p: Promise<T>
      try {
        p = fn()
      } catch (e) {
        // fn 同步抛出时不能登记,否则这个 key 会永远卡住
        return Promise.reject(e)
      }

      // 成功失败都要清掉:失败后必须允许重来,不然一次网络抖动就再也存不了。
      // 清理发生在 wrapped 落定之前的那个微任务里,窗口内的后来者拿到的是
      // 已落定的同一个 Promise —— 对「创建草稿」来说这正是想要的结果。
      const wrapped = p.finally(() => { inflight.delete(key) })
      inflight.set(key, wrapped)
      return wrapped
    },
    has(key) {
      return inflight.has(key)
    },
    size() {
      return inflight.size
    },
  }
}
