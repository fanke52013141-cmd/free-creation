import { useEffect, useState, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { getNodePorts, getNodeType, portOffsets, PORT_COLORS } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { useEdgeSelectionStore } from '../stores/edgeSelection'

interface ScreenEdge {
  id: TLShapeId
  path: string
  color: string
}

function edgePath(start: { x: number; y: number }, end: { x: number; y: number }): string {
  // 业务线只从源端口水平离开、向目标端口水平收束；不用 tldraw Arrow 的 bend，
  // 避免出现用户截图中“向下坠”的大弧线。
  const distance = Math.abs(end.x - start.x)
  const handle = Math.max(42, Math.min(156, distance * 0.46))
  return `M ${start.x} ${start.y} C ${start.x + handle} ${start.y}, ${end.x - handle} ${end.y}, ${end.x} ${end.y}`
}

function collectEdges(editor: Editor, host: HTMLDivElement): ScreenEdge[] {
  const hostRect = host.getBoundingClientRect()
  const result: ScreenEdge[] = []
  for (const arrow of editor.getCurrentPageShapes()) {
    if (arrow.type !== 'arrow') continue
    const bindings = editor.getBindingsFromShape(arrow.id, 'arrow')
    const start = bindings.find((binding) => binding.props.terminal === 'start')
    const end = bindings.find((binding) => binding.props.terminal === 'end')
    if (
      !start ||
      !end ||
      typeof arrow.meta?.fromPort !== 'string' ||
      typeof arrow.meta?.toPort !== 'string'
    ) {
      continue
    }
    const source = editor.getShape<NodeCardShape>(start.toId)
    const target = editor.getShape<NodeCardShape>(end.toId)
    if (source?.type !== 'node-card' || target?.type !== 'node-card') continue
    const sourcePorts = getNodePortsForShape(source)
    const targetPorts = getNodePortsForShape(target)
    const fromIndex = sourcePorts.out.findIndex((port) => port.id === arrow.meta.fromPort)
    const toIndex = targetPorts.in.findIndex((port) => port.id === arrow.meta.toPort)
    if (fromIndex < 0 || toIndex < 0) continue
    const fromY = portOffsets(sourcePorts.out.length, source.props.h)[fromIndex]
    const toY = portOffsets(targetPorts.in.length, target.props.h)[toIndex]
    if (fromY === undefined || toY === undefined) continue
    const startScreen = editor.pageToScreen({ x: source.x + source.props.w, y: source.y + fromY })
    const endScreen = editor.pageToScreen({ x: target.x, y: target.y + toY })
    const fromPort = sourcePorts.out[fromIndex]
    result.push({
      id: arrow.id,
      color: PORT_COLORS[fromPort.type] ?? '#8f73ff',
      path: edgePath(
        { x: startScreen.x - hostRect.left, y: startScreen.y - hostRect.top },
        { x: endScreen.x - hostRect.left, y: endScreen.y - hostRect.top }
      )
    })
  }
  return result
}

function getNodePortsForShape(shape: NodeCardShape): {
  in: ReturnType<typeof getNodePorts>['in']
  out: ReturnType<typeof getNodePorts>['out']
} {
  const spec = getNodeType(shape.props.nodeType)
  return spec ? getNodePorts(spec, shape) : { in: [], out: [] }
}

export function DataEdgeLayer({
  editor,
  hostRef
}: {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [, setRevision] = useState(0)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const selectedEdgeId = useEdgeSelectionStore((state) => state.selectedEdgeId)
  const select = useEdgeSelectionStore((state) => state.select)
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null)

  useEffect(() => {
    let frame = 0
    const update = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setRevision((value) => value + 1)
      })
    }
    const offDocument = editor.store.listen(update, { scope: 'document' })
    const offSession = editor.store.listen(update, { scope: 'session' })
    window.addEventListener('resize', update)
    return () => {
      offDocument()
      offSession()
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
    }
  }, [editor])

  useEffect(() => {
    setHost(hostRef.current)
  }, [hostRef])

  // store/视口监听会触发本组件重绘，确保拖动、缩放和连线后重新换算屏幕坐标。
  const edges = host ? collectEdges(editor, host) : []

  if (!host || edges.length === 0) return null
  return (
    <svg className="data-edge-layer" aria-label="节点数据连线">
      {edges.map((edge) => {
        const active = edge.id === selectedEdgeId
        const hovered = edge.id === hoveredEdgeId
        return (
          <g
            className={`data-edge${active ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`}
            key={edge.id}
          >
            <path className="data-edge-visible" d={edge.path} style={{ stroke: edge.color }} />
            <path
              className="data-edge-hit"
              d={edge.path}
              onPointerDown={(event) => {
                event.preventDefault()
                event.stopPropagation()
                select(edge.id)
              }}
              onPointerEnter={() => setHoveredEdgeId(edge.id)}
              onPointerLeave={() => setHoveredEdgeId(null)}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                select(edge.id)
              }}
            />
          </g>
        )
      })}
    </svg>
  )
}
