import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Vitest 配置（路线图 R2 自动化测试门禁）。
//
// 策略：默认 node 环境，测不依赖渲染运行时的纯函数（Schema、端口、解析、投影、
// 契约收集与校验、执行器纯分支）。需要加载节点注册表（specs）的测试用文件级
// `@vitest-environment jsdom` 切换，因为 specs 会间接拉入 bodies.tsx 的 React/tldraw。
//
// 别名与项目 tsconfig 保持一致；测试只覆盖契约层与执行器纯函数，不测 tldraw Editor
// 和 Electron preload 注入的 window.api（这些留给人工回归与端到端冒烟）。
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@capabilities': resolve(__dirname, 'src/capabilities'),
      '@application': resolve(__dirname, 'src/application')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: true,
    // I/O 密集测试（文件锁、SQLite 事务、fs 读写）在并行全量跑时容易超时。
    // 15s 给足余量，避免假阳性 timeout。
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: [
        'src/shared/node-schemas.ts',
        'src/renderer/src/nodes/registry.tsx',
        'src/renderer/src/nodes/nodeValues.ts',
        'src/renderer/src/engine/contracts.ts',
        'src/renderer/src/engine/executors/shared.ts',
        'src/renderer/src/engine/executors/json.ts',
        'src/renderer/src/engine/executors/processor.ts',
        'src/renderer/src/engine/executors/storyboard.ts'
      ]
    }
  }
})
