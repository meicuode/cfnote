import { defineConfig } from 'vitest/config'

// src/lib/* 里的纯函数单测(改造前 vitest.config.ts 就是这份配置)。
// tests/worker/ 由 vitest.worker.config.ts 接管,这里必须排除,否则会被 node 环境跑一遍必红。
export default defineConfig({
  test: {
    name: 'unit',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/worker/**'],
    environment: 'node',
  },
})
