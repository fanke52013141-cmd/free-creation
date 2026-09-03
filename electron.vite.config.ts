import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 节点卡片渲染链（NodeCardView / NodeCardShape / nodes 目录下的 body 与注册表）
 * 被 tldraw 的 shapeUtils 和 spec 注册表在挂载时缓存了组件引用，
 * React Fast Refresh 的热替换到达不了它们——改动后界面停留在旧版节点卡片。
 * 对这些文件改为整页刷新，保证形状相关改动总能生效。
 */
const forceReloadCanvasShapes = (): Plugin => ({
  name: 'force-reload-canvas-shapes',
  handleHotUpdate(ctx) {
    const normalized = ctx.file.replaceAll('\\', '/')
    const isShapeModule =
      /\/src\/renderer\/src\/canvas\/NodeCardView\.tsx$/.test(normalized) ||
      /\/src\/renderer\/src\/canvas\/NodeCardShape\.tsx$/.test(normalized) ||
      /\/src\/renderer\/src\/nodes\//.test(normalized)
    if (isShapeModule) {
      ctx.server.ws.send({ type: 'full-reload' })
      return []
    }
    return undefined
  }
})

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@capabilities/renderer': resolve('src/capabilities/renderer.ts'),
        '@capabilities': resolve('src/capabilities/index.ts')
      }
    },
    plugins: [forceReloadCanvasShapes(), react()]
  }
})
