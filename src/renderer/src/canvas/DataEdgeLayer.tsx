import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { getNodePorts, getNodeType, portOffsets, PORT_COLORS } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { useEdgeSelectionStore } from '../stores/edgeSelection'
import { buildDataEdgePath, NODE_PORT_OUTSET } from './edge-geometry'

interface ScreenEdge {
  id: TLShapeId
  path: string
  color: string
  provenance?: boolean
}

interface ScreenNodeRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * 返回节点卡片在当前 SVG 坐标系中的边界。
 *
 * 数据线的底图会被这些矩形挖空，随后仅在挖空区再绘制一条低透明度的同色线。
 * 这样“穿过节点”的部分是变淡而不是变成另一种线型，线的其余部分保持完整实线。
 */
function collectNodeRects(editor: Editor, host: HTMLDivElement): ScreenNodeRect[] {
  const hostRect = host.getBoundingClientRect()
  return editor
    .getCurrentPageShapes()
    .filter((shape): shape is NodeCardShape => shape.type === 'node-card')
    .flatMap((shape) => {
      const bounds = editor.getShapePageBounds(shape.id)
      if (!bounds) return []
      const topLeft = editor.pageToScreen({ x: bounds.x, y: bounds.y })
      const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
      return [
        {
          x: topLeft.x - hostRect.left,
          y: topLeft.y - hostRect.top,
          width: Math.max(0, bottomRight.x - topLeft.x),
          height: Math.max(0, bottomRight.y - topLeft.y)
        }
      ]
    })
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
    // 端口圆心位于卡片外侧，正式数据线也以圆心为锚点，不能留一段“线没接上”的空隙。
    const startScreen = editor.pageToScreen({
      x: sourceBounds.maxX + NODE_PORT_OUTSET,
      y: sourceAnchorY
    })
    const endScreen = editor.pageToScreen({
      x: targetBounds.x - NODE_PORT_OUTSET,
      y: targetAnchorY
    })
    const fromPort = sourcePorts.out[fromIndex]
    result.push({
      id: arrow.id,
      color: PORT_COLORS[fromPort.type] ?? '#8f73ff',
      path: buildDataEdgePath(
        { x: startScreen.x - hostRect.left, y: startScreen.y - hostRect.top },
        { x: endScreen.x - hostRect.left, y: endScreen.y - hostRect.top }
      )
    })
  }
  // 运行产物与操作节点的关系只作可视化追溯，绝不能被当成可执行数据边。
  for (const asset of editor.getCurrentPageShapes()) {
    if (asset.type !== 'node-card') continue
    const producerId = (asset.meta as Record<string, unknown> | undefined)?.artifactProducerId
    if (typeof producerId !== 'string') continue
    const producer = editor.getShape<NodeCardShape>(producerId as TLShapeId)
    if (!producer || producer.type !== 'node-card') continue
    const producerBounds = editor.getShapePageBounds(producer.id)
    const assetBounds = editor.getShapePageBounds(asset.id)
    if (!producerBounds || !assetBounds) continue
    const start = editor.pageToScreen({
      x: producerBounds.maxX,
      y: producerBounds.y + producerBounds.height / 2
    })
    const end = editor.pageToScreen({ x: assetBounds.x, y: assetBounds.y + assetBounds.height / 2 })
    result.push({
      id: `artifact:${asset.id}` as TLShapeId,
      color: '#94a3b8',
      provenance: true,
      path: buildDataEdgePath(
        { x: start.x - hostRect.left, y: start.y - hostRect.top },
        { x: end.x - hostRect.left, y: end.y - hostRect.top }
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
  const reactId = useId().replace(/:/g, '')
  const overlapMaskId = `data-edge-node-mask-${reactId}`
  const overlapClipId = `${overlapMaskId}-clip`

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
  const nodeRects = host ? collectNodeRects(editor, host) : []

  /** 判断屏幕坐标是否落在任一连线的可点击描边区域内。 */
  const hitTest = (clientX: number, clientY: number): TLShapeId | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    const point = new DOMPoint(clientX - rect.left, clientY - rect.top)
    for (const path of svg.querySelectorAll<SVGPathElement>('.data-edge-hit')) {
      if (path.isPointInStroke(point)) return path.dataset.edgeId as TLShapeId
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
      // 端口与节点卡片在连接层之上（呈现规范 §8）。连线的 14px 命中描边端点
      // 恰好覆盖端口圆心，若不在这里放行，输出端口一旦接过一条连线就永远
      // 无法再从该端口拖出新连线，所有"一输出扇出多输入"的流程都会被阻断。
      if (event.target instanceof Element && event.target.closest('.node-card-wrap')) return
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit) return
      // 命中连线：选中并终止传播，画布不会开始框选/平移，已选连线也不会被清除。
      event.preventDefault()
      event.stopPropagation()
      select(hit)
    }
    const onContextMenu = (event: MouseEvent): void => {
      if (event.target instanceof Element && event.target.closest('.media-preview-mask')) return
      // 与 pointerdown 同理：落在节点/端口上的右键属于节点，交给节点侧处理。
      if (event.target instanceof Element && event.target.closest('.node-card-wrap')) return
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
  const hostBounds = host.getBoundingClientRect()
  return (
    <svg className="data-edge-layer" ref={svgRef} aria-label="节点数据连线">
      <defs>
        <mask
          id={overlapMaskId}
          maskUnits="userSpaceOnUse"
          x={0}
          y={0}
          width={hostBounds.width}
          height={hostBounds.height}
        >
          <rect width={hostBounds.width} height={hostBounds.height} fill="white" />
          {nodeRects.map((rect, index) => (
            <rect key={index} {...rect} fill="black" />
          ))}
        </mask>
        <clipPath id={overlapClipId} clipPathUnits="userSpaceOnUse">
          {nodeRects.map((rect, index) => (
            <rect key={index} {...rect} />
          ))}
        </clipPath>
      </defs>
      {edges.map((edge) => {
        if (edge.provenance) {
          // 追溯线与数据线共用统一的线条规则：节点之上的片段实线、被节点覆盖的
          // 片段虚线。它不可交互（没有 hit 路径），只是“由该操作产生”的视觉标注。
          return (
            <g key={edge.id}>
              <path
                className="data-edge-visible artifact-provenance-edge"
                d={edge.path}
                mask={`url(#${overlapMaskId})`}
                style={{ stroke: edge.color, pointerEvents: 'none' }}
              />
              <path
                className="data-edge-visible data-edge-obscured artifact-provenance-edge"
                d={edge.path}
                clipPath={`url(#${overlapClipId})`}
                style={{ stroke: edge.color, pointerEvents: 'none' }}
              />
            </g>
          )
        }
        const active = edge.id === selectedEdgeId
        const hovered = edge.id === hoveredEdgeId
        return (
          <g
            className={`data-edge${active ? ' is-selected' : ''}${hovered ? ' is-hovered' : ''}`}
            key={edge.id}
          >
            <path
              className="data-edge-visible"
              d={edge.path}
              mask={`url(#${overlapMaskId})`}
              style={{ stroke: edge.color }}
            />
            <path
              className="data-edge-visible data-edge-obscured"
              d={edge.path}
              clipPath={`url(#${overlapClipId})`}
              style={{ stroke: edge.color }}
            />
            <path className="data-edge-hit" d={edge.path} data-edge-id={edge.id} />
          </g>
        )
      })}
    </svg>
  )
}
