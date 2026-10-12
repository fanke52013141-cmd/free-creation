import type { Editor } from 'tldraw'
import type { NodeCardShape } from './NodeCardShape'
import { getNodeType, getNodePorts } from '../nodes/registry'
import { deriveGraph } from './graph'
import type { FlowDeclarationNode, FlowDeclarationEdge } from '@shared/agent-flow/declarations'

export function canvasFlowDeclarations(editor: Editor): {
  nodes: FlowDeclarationNode[]
  shapes: NodeCardShape[]
  edges: FlowDeclarationEdge[]
} {
  const shapes = editor
    .getCurrentPageShapes()
    .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
  return {
    shapes,
    nodes: shapes.map((shape) => ({
      id: shape.id,
      type: shape.props.nodeType,
      config: shape.props.config,
      outputPortIds: getNodeType(shape.props.nodeType)
        ? getNodePorts(getNodeType(shape.props.nodeType)!, shape).out.map((port) => port.id)
        : []
    })),
    edges: deriveGraph(editor).edges
  }
}
