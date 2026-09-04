import { useEffect, useRef, useState, type RefObject } from 'react'
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
    // 分组后 shape.x/y 是相对父 group 的局部坐标，直接相加会让连线“飘走”。
    // getShapePageBounds 返回页面绝对边界（含父级 group 的平移），端口纵向偏移
    // 再按高度比例映射到页面 bounds，保证任何嵌套层级下锚点都贴住节点边缘。
    const sourceBounds = editor.getShapePageBounds(source.id)
    const targetBounds = editor.getShapePageBounds(target.id)
    if (!sourceBounds || !targetBounds) continue
    const sourceAnchorY =
      source.props.h > 0
        ? sourceBounds.y + (sourceBounds.height * fromY) / source.props.h
        : sourceBounds.y
    const targetAnchorY =
      target.props.h > 0
        ? targetBounds.y + (targetBounds.height * toY) / target.props.h
        : targetBounds.y
    const startScreen = editor.pageToScreen({ x: sourceBounds.maxX, y: sourceAnchorY })
    const endScreen = editor.pageToScreen({ x: targetBounds.x, y: targetAnchorY })
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

/**
 * 节点数据连线覆盖层。
 *
 * 事件策略：本层此前用 14px 宽的透明描边路径直接拦截 pointerdown（DOM 层级在
 * tldraw 画布之外，事件无法传入 .tl-canvas），导致在连线附近按下鼠标时 tldraw
 * 的框选/平移永远无法启动。现在命中路径关闭 DOM 指针事件，选中、悬停与右键
 * 改为在 window 捕获阶段用 SVGGeometryElement.isPointInStroke 手动判定：
 * 命中连线才拦截事件，其余区域完全放行给 tldraw。
 */
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
  const [hoveredEdgeId, setHoveredEdgeId] = useState<TLShapeId | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  // 每条边的命中几何引用；Map 内容由渲染时的 ref 回调维护，始终与当前 edges 一致。
  const hitPathsRef = useRef(new Map<TLShapeId, SVGPathElement>())

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
    // tldraw 的相机缩放/平移不会产生 document 变更；它只在每帧更新 camera。
    // 连线坐标是 pageToScreen 的结果，因此必须在 camera tick 中重算，否则缩放时
    // 节点已经移动而 SVG 仍保留上一帧的端点，视觉上就会出现“线变形/脱离节点”。
    const onTick = (): void => update()
    editor.on('tick', onTick)
    editor.on('resize', onTick)
    window.addEventListener('resize', update)
    return () => {
      offDocument()
      offSession()
      editor.off('tick', onTick)
      editor.off('resize', onTick)
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('resize', update)
    }
  }, [editor])

  useEffect(() => {
    setHost(hostRef.current)
  }, [hostRef])

  // store/视口监听会触发本组件重绘，确保拖动、缩放和连线后重新换算屏幕坐标。
  const edges = host ? collectEdges(editor, host) : []

  /** 判断屏幕坐标是否落在任一连线的可点击描边区域内。 */
  const hitTest = (clientX: number, clientY: number): TLShapeId | null => {
    const svg = svgRef.current
    if (!svg || hitPathsRef.current.size === 0) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    const point = new DOMPoint(clientX - rect.left, clientY - rect.top)
    for (const [id, path] of hitPathsRef.current) {
      if (path.isPointInStroke(point)) return id
    }
    return null
  }

  // window 捕获阶段处理连线交互：先于 tldraw 与 React 合成事件，能精确决定
  // “这次按下属于连线选中”还是“完全放行给画布框选”。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      // 预览弹层通过 portal 挂到 body；弹层上方即使覆盖着一条画布连线，也不能
      // 被连线的 window 捕获监听抢走 pointerdown，否则关闭按钮会收不到 click。
      if (event.target instanceof Element && event.target.closest('.media-preview-mask')) return
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit) return
      // 命中连线：选中并终止传播，画布不会开始框选/平移，已选连线也不会被清除。
      event.preventDefault()
      event.stopPropagation()
      select(hit)
    }
    const onContextMenu = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('.media-preview-mask')) return
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit) return
      // 右键落在连线上：选中该连线，且不让空白处的创建菜单弹出。
      event.preventDefault()
      event.stopPropagation()
      select(hit)
    }
    let moveFrame = 0
    const onPointerMove = (event: PointerEvent): void => {
      if (moveFrame) return
      const { clientX, clientY } = event
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0
        const hit = hitTest(clientX, clientY)
        setHoveredEdgeId((current) => (current === hit ? current : hit))
      })
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    window.addEventListener('pointermove', onPointerMove, { capture: true })
    window.addEventListener('contextmenu', onContextMenu, { capture: true })
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, { capture: true })
      window.removeEventListener('pointermove', onPointerMove, { capture: true })
      window.removeEventListener('contextmenu', onContextMenu, { capture: true })
      if (moveFrame) cancelAnimationFrame(moveFrame)
    }
  }, [select])

  if (!host) return null
  return (
    <svg className="data-edge-layer" ref={svgRef} aria-label="节点数据连线">
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
              ref={(el) => {
                if (el) hitPathsRef.current.set(edge.id, el)
                else hitPathsRef.current.delete(edge.id)
              }}
            />
          </g>
        )
      })}
    </svg>
  )
}
