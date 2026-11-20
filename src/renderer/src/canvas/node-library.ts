import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import type { CompositeCapabilitySummary } from '@shared/composite/types'
import { toast } from '../stores/toast'
import { getNodePorts, getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { createEdge, portPairCompatible } from './graph'
import { markUndoPoint } from './history'
import { templateNodeProps, type WorkflowTemplate } from '../stores/workflow'

/** Add a saved node or connected node set to the current canvas view. */
export function addNodeLibraryEntry(
  editor: Editor,
  entry: WorkflowTemplate,
  markHistory = true,
  dropScreen?: { x: number; y: number }
): { nodeIds: TLShapeId[]; skippedEdges: number } {
  // 拖拽落点优先；没有落点时仍放在视口中心（搜索面板、加号按钮沿用）。
  const center = dropScreen
    ? editor.screenToPage({ x: dropScreen.x, y: dropScreen.y })
    : editor.getViewportPageBounds().center
  const nodeIds: TLShapeId[] = []
  let skippedEdges = 0

  if (markHistory) markUndoPoint(editor, 'before-apply-template')
  editor.run(() => {
    for (const node of entry.nodes) {
      const id = createShapeId()
      nodeIds.push(id)
      editor.createShape({
        id,
        type: 'node-card',
        x: center.x + node.dx,
        y: center.y + node.dy,
        props: { ...templateNodeProps(node) }
      })
    }

    for (const edge of entry.edges) {
      const fromId = nodeIds[edge.fromIdx]
      const toId = nodeIds[edge.toIdx]
      if (!fromId || !toId) continue
      const fromShape = editor.getShape<NodeCardShape>(fromId)
      const toShape = editor.getShape<NodeCardShape>(toId)
      const fromSpec =
        fromShape?.type === 'node-card' ? getNodeType(fromShape.props.nodeType) : undefined
      const toSpec = toShape?.type === 'node-card' ? getNodeType(toShape.props.nodeType) : undefined
      const fromPorts = fromSpec && fromShape ? getNodePorts(fromSpec, fromShape).out : []
      const toPorts = toSpec && toShape ? getNodePorts(toSpec, toShape).in : []
      const fromPort = edge.fromPort
        ? fromPorts.find((port) => port.id === edge.fromPort)
        : fromPorts.length === 1
          ? fromPorts[0]
          : undefined
      const compatibleTargets = fromPort
        ? toPorts.filter((port) => portPairCompatible(fromPort, port))
        : []
      const toPort = edge.toPort
        ? compatibleTargets.find((port) => port.id === edge.toPort)
        : compatibleTargets.length === 1
          ? compatibleTargets[0]
          : undefined
      if (!fromPort || !toPort) {
        skippedEdges += 1
        continue
      }
      if (
        !createEdge(
          editor,
          { shapeId: fromId, portId: fromPort.id },
          { shapeId: toId, portId: toPort.id },
          false
        )
      ) {
        skippedEdges += 1
      }
    }
  })

  if (markHistory) markUndoPoint(editor, 'apply-template')
  return { nodeIds, skippedEdges }
}

export async function insertPublishedNodeFlow(
  editor: Editor,
  capability: Pick<CompositeCapabilitySummary, 'id' | 'name' | 'latestVersion'>,
  dropScreen?: { x: number; y: number }
): Promise<'success' | 'failed' | 'cancelled'> {
  const version = capability.latestVersion
  if (!version) {
    toast('该组合还没有已发布版本')
    return 'failed'
  }
  const pageId = editor.getCurrentPageId()
  const center = dropScreen
    ? editor.screenToPage(dropScreen)
    : editor.getViewportPageBounds().center
  try {
    const result = await window.api.composite.versionGet({ capabilityId: capability.id, version })
    if (editor.isDisposed || editor.getCurrentPageId() !== pageId) return 'cancelled'
    if (!result.ok || !result.data) {
      toast('读取组合版本失败')
      return 'failed'
    }
    const id = createShapeId()
    markUndoPoint(editor, 'insert-composite-node')
    editor.createShape({
      id,
      type: 'node-card',
      x: center.x - 170,
      y: center.y - 130,
      props: {
        nodeType: 'composite',
        title: capability.name,
        w: 340,
        h: 260,
        config: JSON.stringify({
          capabilityId: capability.id,
          version,
          contentHash: result.data.contentHash
        })
      },
      meta: { compositeManifest: result.data.manifest }
    } as never)
    editor.select(id)
    toast(`已添加节点流「${capability.name} v${version.replace(/\.0\.0$/, '.0')}」`)
    return 'success'
  } catch {
    toast('添加节点流失败')
    return 'failed'
  }
}
