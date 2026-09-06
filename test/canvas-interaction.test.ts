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

  it('媒体导入与调色板建节点共用避让网格，反复导入不再堆叠', () => {
    expect(canvasEditorSource).toContain(
      'const placement = findNodePlacement(editor, point, spec.defaultSize)'
    )
  })

  it('画布挂载前的建节点请求必须排队补建，不得静默丢弃', () => {
    expect(canvasEditorSource).toContain('pendingCreationRef.current.push')
    expect(canvasEditorSource).toContain('画布就绪，已补建')
  })

  it('外部修改重载必须保留未落盘的新增内容与相机视角', () => {
    expect(canvasEditorSource).toContain('mergeUnsavedLocalRecords')
    expect(canvasEditorSource).toContain('editor.setCamera(camera)')
    expect(canvasEditorSource).toContain('未保存的新增内容')
  })
})
