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
 * Connected/default groups own primary slots; candidates use spare slots without moving anchors.
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
  const candidateTypes = groupTypes.filter((type) =>
    grouped.some((port) => port.type === type && candidatePortIds.has(port.id))
  )
  // 任意类型可匹配多个输入：沿用已有/默认连接点，不能因此展开全部类型。
  const candidateType =
    candidateTypes.find((type) =>
      grouped.some((port) => port.type === type && connectedPortIds.has(port.id))
    ) ?? candidateTypes[0]
  const activeIds = new Set([
    ...connectedPortIds,
    ...grouped
      .filter((port) => port.type === candidateType && candidatePortIds.has(port.id))
      .map((port) => port.id)
  ])
  const activeTypes = new Set(
    grouped.filter((port) => activeIds.has(port.id)).map((port) => port.type)
  )
  // Every side has a usable default connector, including nodes with several optional types.
  if (activeTypes.size === 0 && groupTypes.length > 0) activeTypes.add(groupTypes[0])
  const visibleTypes = groupTypes.filter((type) => activeTypes.has(type))
  const connectedTypes = groupTypes.filter((type) =>
    grouped.some((port) => port.type === type && connectedPortIds.has(port.id))
  )
  const anchorTypes = connectedTypes.length ? connectedTypes : groupTypes.slice(0, 1)
  const positions = portOffsets(anchorTypes.length + forced.length, cardHeight)
  const sparePositions = portOffsets(groupTypes.length + forced.length + 1, cardHeight).filter(
    (position) => !positions.some((anchor) => Math.abs(anchor - position) < 0.01)
  )
  let spareIndex = 0
  const visiblePorts: PortDecl[] = []
  const offsets = new Map<string, number>()

  groupTypes.forEach((type) => {
    const sameType = grouped.filter((port) => port.type === type)
    const representative =
      sameType.find((port) => candidatePortIds.has(port.id)) ??
      sameType.find((port) => connectedPortIds.has(port.id)) ??
      sameType[0]
    if (representative && visibleTypes.includes(type)) visiblePorts.push(representative)
    const anchorIndex = anchorTypes.indexOf(type)
    const position = anchorIndex >= 0 ? positions[anchorIndex] : sparePositions[spareIndex++]
    for (const port of sameType) offsets.set(port.id, position)
  })
  forced.forEach((port, index) => {
    visiblePorts.push(port)
    offsets.set(port.id, positions[anchorTypes.length + index])
  })

  return { ports: visiblePorts, offsets }
}
