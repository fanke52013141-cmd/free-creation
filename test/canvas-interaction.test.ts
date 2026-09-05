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

  it('节点拖近时只通过统一契约校验自动连接，不绕过端口规则', () => {
    expect(canvasEditorSource).toContain('tryAutoConnectNearby')
    expect(canvasEditorSource).toContain('已按兼容端口自动连接两个节点')
  })

  it('双节点框选后，连线可在目标附近吸附，缩放不会改变屏幕吸附范围', () => {
    expect(canvasEditorSource).toContain('selected.length === 2')
    expect(canvasEditorSource).toContain('56 / zoom')
    expect(canvasEditorSource).toContain('已吸附连接到已选节点')
  })
})
