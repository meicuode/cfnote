import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Worker 端到端:在 workerd(miniflare)里跑真的 worker/index.ts,配真的 D1 与 R2。
//
// 注意 API 形态:vitest-pool-workers 0.19(对应 vitest 4)取消了
// `@cloudflare/vitest-pool-workers/config` 与 `test.poolOptions.workers`,
// 改为一个 Vite 插件 cloudflareTest(...)。包内自带的 v3→v4 codemod 就是这个映射。
//
// 存储隔离:每个 it 结束后 D1/R2 回滚,所以每个用例都是一个全新的空库,
// 这正是「全新初始化」这类断言需要的前提。
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.toml' },
    }),
  ],
  test: {
    name: 'worker',
    include: ['tests/worker/**/*.test.ts'],
    // 默认 5 秒对这批用例太紧:每个 it 都真的丢表建表 + 跑 bootstrap(注册与登录各一轮
    // 10 万次迭代的 PBKDF2),而 `npm test` 里 unit 与 worker 两个 project 是并行的,
    // CPU 一抢就集体超时——P16.6 第一次跑就是这样挂了 3 个我根本没碰的文件,
    // 排查方向被带偏成「是不是共用面回归了」。抬到 20 秒:真卡死照样会被抓住,
    // 但不会再让并行调度的抖动伪装成断言失败
    testTimeout: 20000,
  },
})
