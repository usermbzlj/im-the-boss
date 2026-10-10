import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    open: true,
  },
  test: {
    // 默认 node 环境（引擎 / 运行时测试）；组件测试放 tests/ui/*.test.tsx，
    // 文件头部写 `// @vitest-environment jsdom` 单独切到 jsdom，不拖慢其余测试
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 60_000,
  },
})
