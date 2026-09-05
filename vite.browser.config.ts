import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 浏览器验收专用 Vite 入口。
 * Electron 使用 electron.vite.config.ts；这里明确把 renderer 目录设为 root，
 * 并复制 renderer 运行时需要的 alias，避免直接执行 vite 时出现 404 或 @shared 白屏。
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@capabilities/renderer': resolve(__dirname, 'src/capabilities/renderer.ts'),
      '@capabilities': resolve(__dirname, 'src/capabilities/index.ts'),
      '@application': resolve(__dirname, 'src/application/index.ts'),
      '@application/': resolve(__dirname, 'src/application/')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})
