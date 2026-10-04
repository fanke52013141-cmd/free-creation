import { createShapeId, type Editor, type TLShapeId } from 'tldraw'
import { getNodePorts, getNodeType } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { createEdge, portPairCompatible } from './graph'
import { markUndoPoint } from './history'
import { templateNodeProps, type WorkflowTemplate } from '../stores/workflow'

/** Add a saved node or connected node set to the current canvas view. */
export function addNodeLibraryEntry(
  editor: Editor,
  entry: WorkflowTemplate,
  markHistory = true
): { nodeIds: TLShapeId[]; skippedEdges: number } {
  const center = editor.getViewportPageBounds().center
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
