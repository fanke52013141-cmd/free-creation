import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/**
 * 节点卡片渲染链（NodeCardView / NodeCardShape / 端口布局 / nodes 目录下的 body 与注册表）
 * 被 tldraw 的 shapeUtils 和 spec 注册表在挂载时缓存了组件引用，
 * React Fast Refresh 的热替换到达不了它们——改动后界面停留在旧版节点卡片。
 * 对这些文件改为整页刷新，保证形状相关改动总能生效。
 */
/** 发行版构建开关：CANVAS_DISTRIBUTION=1 时注入 __CANVAS_DISTRIBUTION__=true（见 src/shared/edition.ts）。 */
/** 自用版开关：CANVAS_OWNER=1 时注入 __CANVAS_OWNER__=true（跳过授权、保留全部节点）。 */
const editionDefine = {
  __CANVAS_DISTRIBUTION__: JSON.stringify(process.env.CANVAS_DISTRIBUTION === '1'),
  __CANVAS_OWNER__: JSON.stringify(process.env.CANVAS_OWNER === '1')
}

const forceReloadCanvasShapes = (): Plugin => ({
  name: 'force-reload-canvas-shapes',
  handleHotUpdate(ctx) {
    const normalized = ctx.file.replaceAll('\\', '/')
    const isShapeModule =
      /\/src\/renderer\/src\/canvas\/NodeCardView\.tsx$/.test(normalized) ||
      /\/src\/renderer\/src\/canvas\/NodeCardShape\.tsx$/.test(normalized) ||
      /\/src\/renderer\/src\/canvas\/node-port-layout\.ts$/.test(normalized) ||
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
    define: editionDefine,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'local-agent': resolve('src/local-agent/index.ts'),
          'agent-flow-c0': resolve('src/main/agent-flow/c0-electron.ts'),
          'agent-flow-model-probe': resolve('src/main/agent-flow/model-probe-electron.ts'),
          'agent-flow-assets': resolve('src/main/agent-flow/assets-electron.ts'),
          'agent-flow-commands': resolve('src/main/agent-flow/commands-electron.ts'),
          'agent-flow-desktop': resolve('src/main/agent-flow/desktop-electron.ts'),
          'media-local': resolve('src/main/media/local-media-electron.ts'),
          'save-recovery': resolve('src/main/store/save-recovery-electron.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@free-creation/model-contracts': resolve('packages/model-contracts/src/index.ts'),
        '@free-creation/model-runtime': resolve('packages/model-runtime/src/index.ts'),
        '@free-creation/license-protocol': resolve('packages/license-protocol/src/index.ts')
      }
    }
  },
  preload: {
    define: editionDefine,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          // 授权窗隔离 preload：与业务 preload 完全分离（方案 §3.3）。
          license: resolve('src/preload/license.ts')
        }
      }
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@free-creation/model-contracts': resolve('packages/model-contracts/src/index.ts'),
        '@free-creation/license-protocol': resolve('packages/license-protocol/src/index.ts')
      }
    }
  },
  renderer: {
    define: editionDefine,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          // 授权窗第二入口（极简页面，不引入业务模块）。
          license: resolve('src/renderer/license.html')
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared'),
        '@free-creation/model-contracts': resolve('packages/model-contracts/src/index.ts'),
        '@free-creation/license-protocol': resolve('packages/license-protocol/src/index.ts')
      }
    },
    plugins: [forceReloadCanvasShapes(), react()]
  }
})
