import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const canvasEditorSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/CanvasEditor.tsx'),
  'utf8'
)
const dataEdgeLayerSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/DataEdgeLayer.tsx'),
  'utf8'
)
const edgeSurfaceSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/ui-surfaces.css'),
  'utf8'
)
const imageSplitBodySource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/nodes/specs/bodies/image-split.tsx'),
  'utf8'
)
const imageGenBodySource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/nodes/specs/bodies/image-gen.tsx'),
  'utf8'
)
const nodeCardViewSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/NodeCardView.tsx'),
  'utf8'
)
const groupOutlineSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/GroupOutlineLayer.tsx'),
  'utf8'
)
const graphSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/canvas/graph.ts'), 'utf8')
const nodeCreateOptionsSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/canvas/node-create-options.ts'),
  'utf8'
)
const canvasSurfaceSource = readFileSync(
  resolve(process.cwd(), 'src/renderer/src/assets/app.css'),
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

  it('批量删除节点时优先删除节点及关联连线，不要求先执行一次删线', () => {
    const nodePriority = canvasEditorSource.indexOf('节点/分组的批量删除永远优先于连线选择')
    const edgeDelete = canvasEditorSource.indexOf('数据连线由专用连接层选中')
    expect(nodePriority).toBeGreaterThan(-1)
    expect(edgeDelete).toBeGreaterThan(nodePriority)
    expect(canvasEditorSource).toContain("getBindingsFromShape(shape.id, 'arrow')")
    expect(canvasEditorSource).toContain('editor.deleteShapes([...selected, ...linkedArrows])')
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

  it('数据线穿过节点时只降低被遮挡片段的不透明度，正常段保持实线', () => {
    expect(dataEdgeLayerSource).toContain('function collectNodeRects')
    expect(dataEdgeLayerSource).toContain('mask={`url(#${overlapMaskId})`}')
    expect(dataEdgeLayerSource).toContain('clipPath={`url(#${overlapClipId})`}')
    expect(dataEdgeLayerSource).toContain('data-edge-obscured')
    expect(edgeSurfaceSource).toContain('.data-edge-obscured')
    expect(edgeSurfaceSource).not.toMatch(/\.data-edge-visible\s*\{[^}]*stroke-dasharray/m)
  })

  it('图片拆分的高频参数与执行入口必须直接放在节点内', () => {
    expect(imageSplitBodySource).toContain('image-split-quick-controls')
    expect(imageSplitBodySource).toContain('image-split-quick-grid')
    expect(imageSplitBodySource).toContain("'快速拆分'")
    expect(imageSplitBodySource).toContain(
      "gatherUpstreamMedia(editor, shape.id, 'in-image', 'image')"
    )
    expect(imageSplitBodySource).not.toContain('配置拆分')
  })

  it('继续生图节点只在卡片中展示模型与画幅，不再暴露自动尺寸下拉', () => {
    expect(imageGenBodySource).toContain('<ModelSelect')
    expect(imageGenBodySource).toContain('value={config.aspectRatio}')
    expect(imageGenBodySource).not.toContain('value={config.size}')
  })

  it('多选节点可以从任一输出口或选框外公共端口进行真实批量连接', () => {
    expect(nodeCardViewSource).toContain(
      'batchConnectionFromSelection(editor, selectedNodeIds, p.id)'
    )
    expect(groupOutlineSource).toContain('canvas-selection-batch-port')
    expect(groupOutlineSource).toContain('beginConnectionDrag(selection.batchSource!')
    expect(graphSource).toContain('export function tryConnectBatch')
    expect(graphSource).toContain("port.cardinality === 'many'")
    expect(graphSource).toContain('批量连接会形成循环，未创建任何连线')
    expect(nodeCreateOptionsSource).toContain("port.cardinality === 'many'")
  })

  it('导入图片保留资产名称作为图片节点名称，并将过长标题限制在固定操作区前', () => {
    expect(canvasEditorSource).toContain('title: asset.name ?? spec.label')
    expect(canvasSurfaceSource).toContain('flex: 1 1 0;')
    expect(canvasSurfaceSource).toContain('text-overflow: ellipsis;')
  })

  it('外部视频、图片或文件拖入时只在落点显示投放提示，不给整张画布加虚线边框', () => {
    expect(canvasEditorSource).toContain('const [dropPoint, setDropPoint]')
    expect(canvasEditorSource).toContain('松开以添加资产')
    expect(canvasEditorSource).toContain('将在此处创建节点')
    expect(canvasSurfaceSource).toContain('.drop-hint-icon')
    expect(canvasSurfaceSource).not.toContain('.canvas-host.drag-over::after')
    expect(canvasEditorSource).toContain("window.addEventListener('dragend', clearDropFeedback")
    expect(canvasEditorSource).toContain('onDropCapture={(e) => void handleDrop(e)}')
    expect(canvasEditorSource).toContain('const dropImportInFlightRef = useRef(false)')
    expect(canvasEditorSource).toContain('e.stopPropagation()')
    expect(canvasEditorSource).toContain('paths.every(Boolean)')
    expect(canvasEditorSource).toContain('await file.arrayBuffer()')
  })

  it('媒体封面保持普通鼠标，所有视频预览使用大尺寸原生播放器', () => {
    expect(canvasSurfaceSource).toContain('cursor: default;')
    expect(nodeCardViewSource).toContain('media-preview-${preview.kind}')
    expect(nodeCardViewSource).toContain('playsInline')
    expect(nodeCardViewSource).toContain('preload="auto"')
    expect(edgeSurfaceSource).toContain('.media-preview-box.media-preview-video')
    expect(edgeSurfaceSource).toContain('width: min(94vw, 1280px);')
    expect(edgeSurfaceSource).toContain('.media-preview-video .media-preview-stage video')
  })

  it('节点标题稳定支持双击重命名，且不与画布指针捕获冲突', () => {
    expect(nodeCardViewSource).toContain('data-node-interactive="node-title"')
    expect(nodeCardViewSource).toContain('canvas:edit-node-title')
    expect(nodeCardViewSource).toContain('beginTitleEditing')
    expect(canvasEditorSource).toContain('dispatchEditNodeTitle')
    expect(canvasEditorSource).toContain('[data-node-interactive="node-title"]')
  })
})
