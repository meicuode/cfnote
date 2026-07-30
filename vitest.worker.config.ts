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
  },
})
