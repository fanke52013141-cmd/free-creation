import type { Editor } from 'tldraw'
import type { PortDecl, PortType } from '@shared/types'
import { portOffsets } from '../nodes/registry'

export interface NodePortConnections {
  in: Set<string>
  out: Set<string>
}

export interface NodePortLayout {
  /** One representative contract port per visible type group. */
  ports: PortDecl[]
  /** Every contract port in a visible type group shares its visual anchor. */
  offsets: Map<string, number>
}

/**
 * Collect formal data connections and artifact provenance connections by node/port.
 * Provenance remains visual-only but occupies the producer's output connector.
 */
export function collectNodePortConnections(editor: Editor): Map<string, NodePortConnections> {
  const result = new Map<string, NodePortConnections>()
  const forNode = (shapeId: string): NodePortConnections => {
    let ports = result.get(shapeId)
    if (!ports) {
      ports = { in: new Set<string>(), out: new Set<string>() }
      result.set(shapeId, ports)
    }
    return ports
  }

  for (const arrow of editor.getCurrentPageShapes()) {
    if (arrow.type !== 'arrow') continue
    const fromPort = arrow.meta?.fromPort
    const toPort = arrow.meta?.toPort
    if (typeof fromPort !== 'string' || typeof toPort !== 'string') continue
    const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
    const start = bindings.find((binding) => binding.props.terminal === 'start')
    const end = bindings.find((binding) => binding.props.terminal === 'end')
    if (!start || !end) continue
    if (editor.getShape(start.toId)?.type === 'node-card') forNode(start.toId).out.add(fromPort)
    if (editor.getShape(end.toId)?.type === 'node-card') forNode(end.toId).in.add(toPort)
  }

  for (const shape of editor.getCurrentPageShapes()) {
    if (shape.type !== 'node-card') continue
    const meta = shape.meta as Record<string, unknown> | undefined
    if (
      typeof meta?.artifactProducerId === 'string' &&
      typeof meta.artifactProducerPortId === 'string'
    ) {
      forNode(meta.artifactProducerId).out.add(meta.artifactProducerPortId)
    }
  }

  return result
}

/**
 * Build the visual connector layout for one side of a node.
 * Connected and temporary compatible candidate ports are grouped by PortType;
 * duplicate edges therefore share one anchor, while different types divide height.
 */
export function createNodePortLayout(
  ports: PortDecl[],
  connectedPortIds: ReadonlySet<string>,
  cardHeight: number,
  candidatePortIds: ReadonlySet<string> = new Set()
): NodePortLayout {
  const activeIds = new Set([...connectedPortIds, ...candidatePortIds])
  if (activeIds.size === 0 && ports[0]) activeIds.add(ports[0].id)

  const activeTypes = new Set<PortType>()
  for (const port of ports) {
    if (activeIds.has(port.id)) activeTypes.add(port.type)
  }

  // Preserve the contract order, but collapse each active type into one visual point.
  const groupTypes = [
    ...new Set(ports.filter((port) => activeTypes.has(port.type)).map((port) => port.type))
  ]
  const positions = portOffsets(groupTypes.length, cardHeight)
  const visiblePorts: PortDecl[] = []
  const offsets = new Map<string, number>()

  groupTypes.forEach((type, index) => {
    const sameType = ports.filter((port) => port.type === type)
    const representative =
      sameType.find((port) => candidatePortIds.has(port.id)) ??
      sameType.find((port) => connectedPortIds.has(port.id)) ??
      sameType[0]
    if (representative) visiblePorts.push(representative)
    for (const port of sameType) offsets.set(port.id, positions[index])
  })

  return { ports: visiblePorts, offsets }
}
