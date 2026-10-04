import type { Editor } from 'tldraw'
import type { PortDecl } from '@shared/types'
import { portOffsets } from '../nodes/registry'

export interface NodePortConnections {
  in: Set<string>
  out: Set<string>
}

export interface NodePortLayout {
  /** One representative contract port per visible type group, plus every forced port. */
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
 * Ports are grouped by PortType; duplicate same-type ports share one anchor. In the idle
 * state only the first declared type is shown. Connecting another distinct type (or
 * temporarily highlighting a compatible candidate) reveals that type's connector too.
 * Forced ports (user-declared dynamic ports such as code-node params and output fields)
 * are exempt from grouping: they always render and each keeps an independent anchor, so
 * every declared port stays individually droppable and reachable.
 * All anchors divide the node height evenly.
 */
export function createNodePortLayout(
  ports: PortDecl[],
  connectedPortIds: ReadonlySet<string>,
  cardHeight: number,
  candidatePortIds: ReadonlySet<string> = new Set(),
  forcedPortIds: ReadonlySet<string> = new Set()
): NodePortLayout {
  if (ports.length === 0) return { ports: [], offsets: new Map() }
  const forced = ports.filter((port) => forcedPortIds.has(port.id))
  const grouped = ports.filter((port) => !forcedPortIds.has(port.id))

  const groupTypes = [...new Set(grouped.map((port) => port.type))]
  const activeIds = new Set([...connectedPortIds, ...candidatePortIds])
  const activeTypes = new Set(
    grouped.filter((port) => activeIds.has(port.id)).map((port) => port.type)
  )
  // Every side has a usable default connector, including nodes with several optional types.
  if (activeTypes.size === 0 && groupTypes.length > 0) activeTypes.add(groupTypes[0])
  const visibleTypes = groupTypes.filter((type) => activeTypes.has(type))
  const positions = portOffsets(visibleTypes.length + forced.length, cardHeight)
  const visiblePorts: PortDecl[] = []
  const offsets = new Map<string, number>()

  visibleTypes.forEach((type, index) => {
    const sameType = grouped.filter((port) => port.type === type)
    const representative =
      sameType.find((port) => candidatePortIds.has(port.id)) ??
      sameType.find((port) => connectedPortIds.has(port.id)) ??
      sameType[0]
    if (representative) visiblePorts.push(representative)
    for (const port of sameType) offsets.set(port.id, positions[index])
  })
  forced.forEach((port, index) => {
    visiblePorts.push(port)
    offsets.set(port.id, positions[visibleTypes.length + index])
  })

  return { ports: visiblePorts, offsets }
}
