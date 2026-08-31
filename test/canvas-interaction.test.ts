import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const canvasEditorSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/CanvasEditor.tsx'),
  'utf8'
)

describe('画布创建节点交互', () => {
  it('只允许右键打开新建节点菜单，双击绝不承担创建职责', () => {
    expect(canvasEditorSource).toContain('onContextMenu={handleContextMenu}')
    expect(canvasEditorSource).not.toContain('双击空白画布弹节点菜单')
    expect(canvasEditorSource).toContain("new CustomEvent('canvas:edit-text-node')")
  })

  it('画布只保留工作流节点、真实数据连线和分组，默认绘制形状会被清理', () => {
    expect(canvasEditorSource).toContain('function isWorkflowCanvasShape')
    expect(canvasEditorSource).toContain('function removeUnsupportedCanvasShapes')
    expect(canvasEditorSource).toContain("editor.setCurrentTool('select')")
    expect(canvasEditorSource).toContain("registerAfterCreateHandler('shape'")
  })
})
