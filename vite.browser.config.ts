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
  plugins: [
    react(),
    {
      name: 'browser-session-media-csp',
      // 浏览器适配器将小型音视频保存为 data URL；只放宽验收入口的媒体源，桌面 CSP 不变。
      transformIndexHtml: (html): string =>
        html.replace("media-src 'self' blob: media:", "media-src 'self' data: blob: media:")
    }
  ],
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true
  }
})
