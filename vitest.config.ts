import { defineConfig } from 'vitest/config'

// 两个 project:纯函数单测跑在 node 里,Worker e2e 跑在 workerd 里(见 vitest.worker.config.ts)。
// pool 是按 project 设的,所以必须拆开;`npx vitest run` 仍然一次跑完两边。
export default defineConfig({
  test: {
    projects: ['vitest.unit.config.ts', 'vitest.worker.config.ts'],
  },
})
