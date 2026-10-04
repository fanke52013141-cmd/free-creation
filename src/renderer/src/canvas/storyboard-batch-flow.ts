import { DiagnosticsProducer, newTraceId } from '@shared/observability'
import { emitDiagnosticsEvent } from '../engine/diagnosticsReporter'
import { useAppStore } from '../stores/app'
import type { Editor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { addNodeLibraryEntry } from './node-library'
import { createEdge } from './graph'
import { markUndoPoint } from './history'
import type { WorkflowTemplate } from '../stores/workflow'
import { toast } from '../stores/toast'

const diagnostics = new DiagnosticsProducer({
  process: 'renderer',
  producerId: 'storyboard-batch-flow'
})

export const storyboardBatchTemplate: WorkflowTemplate = {
  id: 'builtin-storyboard-batch',
  name: '分镜转对象列表并局部续跑',
  createdAt: 0,
  nodeCount: 3,
  nodes: [
    {
      nodeType: 'processor',
      title: '提取镜头列表',
      dx: 0,
      dy: 0,
      w: 340,
      h: 260,
      config: JSON.stringify({ operation: 'pick', path: 'shots' })
    },
    {
      nodeType: 'structured',
      title: '校验镜头列表',
      dx: 450,
      dy: 0,
      w: 340,
      h: 260,
      config: JSON.stringify({ schema: { id: 'list.items', version: 1 } }),
      text: '"{{input[0]}}"'
    },
    {
      nodeType: 'iterate',
      title: '按镜头批处理',
      dx: 900,
      dy: 0,
      w: 340,
      h: 260,
      config: JSON.stringify({ runMode: 'changed', onFailure: 'skip', maxRetries: 0, limit: 0 })
    }
  ],
  edges: [
    { fromIdx: 0, toIdx: 1, fromPort: 'out-value', toPort: 'in-context' },
    { fromIdx: 1, toIdx: 2, fromPort: 'out-json', toPort: 'in-list' }
  ]
}

/** Creates visible declared nodes and real data edges; no hidden execution. */
export function createStoryboardBatchFlow(editor: Editor, source: NodeCardShape): void {
  markUndoPoint(editor, 'storyboard-batch-flow')
  editor.run(() => {
    const before = new Set(editor.getCurrentPageShapes().map((shape) => shape.id))
    const result = addNodeLibraryEntry(editor, storyboardBatchTemplate, false)
    const connected =
      result.skippedEdges === 0 &&
      createEdge(
        editor,
        { shapeId: source.id, portId: 'out-json' },
        { shapeId: result.nodeIds[0], portId: 'in-value' },
        false
      )
    if (!connected) {
      editor.deleteShapes(
        editor
          .getCurrentPageShapes()
          .filter((shape) => !before.has(shape.id))
          .map((shape) => shape.id)
      )
      emitDiagnosticsEvent(
        diagnostics.build('canvas.batch_flow.failed', undefined, '分镜批处理创建失败', {
          projectId: useAppStore.getState().currentProject?.id,
          nodeId: source.id,
          traceId: newTraceId()
        })
      )
      toast('无法创建批处理连线，未保留半成品')
      return
    }
    emitDiagnosticsEvent(
      diagnostics.build(
        'canvas.batch_flow.created',
        undefined,
        '分镜批处理已创建',
        {
          projectId: useAppStore.getState().currentProject?.id,
          nodeId: source.id,
          traceId: newTraceId()
        },
        { attributes: { itemCount: result.nodeIds.length } }
      )
    )
    editor.setSelectedShapes(result.nodeIds)
    editor.zoomToSelection()
    toast(
      '已创建分镜批处理流程；从循环“当前项”连接处理节点，再运行。修改项与失败项模式会保留未改动的成功结果。'
    )
  })
  markUndoPoint(editor, 'storyboard-batch-flow-complete')
}
