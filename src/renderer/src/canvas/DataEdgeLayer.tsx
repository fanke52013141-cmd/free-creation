import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { getNodePorts, getNodeType, portOffsets, PORT_COLORS } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { useEdgeSelectionStore } from '../stores/edgeSelection'
import { buildDataEdgePath, NODE_PORT_OUTSET } from './edge-geometry'
import { markUndoPoint } from './history'
import { toast } from '../stores/toast'

interface ScreenEdge {
  id: TLShapeId
  path: string
  color: string
  /** 视觉流向始终由真实数据源指向真实消费者（或由操作节点指向其产物）。 */
  sourceId: TLShapeId
  targetId: TLShapeId
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
 * 数据线会被这些矩形挖空。节点始终是画布最上层的实体，连线不能穿透其内容区。
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
      sourceId: source.id,
      targetId: target.id,
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
    const producerPorts = getNodePortsForShape(producer)
    const artifactPortId = (asset.meta as Record<string, unknown> | undefined)
      ?.artifactProducerPortId
    const fromIndex =
      typeof artifactPortId === 'string'
        ? producerPorts.out.findIndex((p) => p.id === artifactPortId)
        : -1
    const outIdx = fromIndex >= 0 ? fromIndex : producerPorts.out.length > 0 ? 0 : -1
    const fromY =
      outIdx >= 0 ? portOffsets(producerPorts.out.length, producer.props.h)[outIdx] : undefined
    const sourceAnchorY =
      fromY !== undefined && producer.props.h > 0
        ? producerBounds.y + (producerBounds.height * fromY) / producer.props.h
        : producerBounds.y + producerBounds.height / 2

    const assetPorts = getNodePortsForShape(asset as NodeCardShape)
    const inIdx = assetPorts.in.length > 0 ? 0 : -1
    const toY =
      inIdx >= 0
        ? portOffsets(assetPorts.in.length, (asset as NodeCardShape).props.h)[inIdx]
        : undefined
    const targetAnchorY =
      toY !== undefined && (asset as NodeCardShape).props.h > 0
        ? assetBounds.y + (assetBounds.height * toY) / (asset as NodeCardShape).props.h
        : assetBounds.y + assetBounds.height / 2

    const start = editor.pageToScreen({
      x: producerBounds.maxX + NODE_PORT_OUTSET,
      y: sourceAnchorY
    })
    const end = editor.pageToScreen({
      x: assetBounds.x - NODE_PORT_OUTSET,
      y: targetAnchorY
    })
    const outPort = outIdx >= 0 ? producerPorts.out[outIdx] : undefined
    // 追溯线的颜色跟随“被产出的资产类型”，而不是生产者的端口类型：宫格拆分的
    // 集合端口是 json（紫），但它产出的每一个都是图片，画成紫色会让用户以为
    // 拆分结果不是图片（用户 2026-09-18 反馈）。无资产输出端口时回退生产者端口。
    const assetOutType = assetPorts.out[0]?.type
    result.push({
      id: `artifact:${asset.id}` as TLShapeId,
      color: assetOutType
        ? (PORT_COLORS[assetOutType] ?? '#94a3b8')
        : outPort
          ? (PORT_COLORS[outPort.type] ?? '#94a3b8')
          : '#94a3b8',
      sourceId: producer.id,
      targetId: asset.id,
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
  const clearEdgeSelection = useEdgeSelectionStore((state) => state.clear)
  const [hoveredEdge, setHoveredEdge] = useState<{
    id: TLShapeId
    clientX: number
    clientY: number
  } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const reactId = useId().replace(/:/g, '')
  const overlapMaskId = `data-edge-node-mask-${reactId}`

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
  const nodeRectsRef = useRef<ScreenNodeRect[]>([])
  useEffect(() => {
    nodeRectsRef.current = nodeRects
  })

  /** 判断屏幕坐标是否落在任一连线的可点击描边区域内。 */
  const hitTest = (clientX: number, clientY: number): TLShapeId | null => {
    const svg = svgRef.current
    if (!svg) return null
    const rect = svg.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    const point = new DOMPoint(clientX - rect.left, clientY - rect.top)
    // 数据线即使几何上穿过卡片，也只能在节点下方；节点内部不能选中线、更不能出现剪刀。
    if (
      nodeRectsRef.current.some(
        (node) =>
          point.x >= node.x &&
          point.x <= node.x + node.width &&
          point.y >= node.y &&
          point.y <= node.y + node.height
      )
    ) {
      return null
    }
    // 端口可在无可见半圆提示的范围内跟随鼠标。该范围优先属于端口，不属于连线删除。
    const insidePortZone = Array.from(document.querySelectorAll<HTMLElement>('.port-dot')).some(
      (port) => {
        const portRect = port.getBoundingClientRect()
        return (
          Math.hypot(
            clientX - (portRect.left + portRect.width / 2),
            clientY - (portRect.top + portRect.height / 2)
          ) <= 27
        )
      }
    )
    if (insidePortZone) return null
    for (const path of svg.querySelectorAll<SVGPathElement>('.data-edge-hit')) {
      if (path.isPointInStroke(point)) return path.dataset.edgeId as TLShapeId
    }
    return null
  }

  // window 捕获阶段处理连线交互：先于 tldraw 与 React 合成事件，能精确决定
  // “这次按下属于连线选中”还是“完全放行给画布框选”。
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      // 剪刀是唯一会删除连线的显式操作，不能被窗口捕获阶段的连线选中逻辑截获。
      if (event.target instanceof Element && event.target.closest('.data-edge-scissors')) return
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
      // 一条数据线被选中时，必须解除之前的节点选区。否则 Delete 会按节点批量删除
      // 的分支执行，把上游节点和其余关联线一并删掉。
      editor.setSelectedShapes([])
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
      editor.setSelectedShapes([])
      select(hit)
    }
    let moveFrame = 0
    const onPointerMove = (event: PointerEvent): void => {
      if (moveFrame) return
      const { clientX, clientY } = event
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0
        const hit = hitTest(clientX, clientY)
        setHoveredEdge((current) => {
          if (!hit) return current === null ? current : null
          if (current?.id === hit && current.clientX === clientX && current.clientY === clientY) {
            return current
          }
          return { id: hit, clientX, clientY }
        })
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
  }, [editor, select])

  if (!host) return null
  const hostBounds = host.getBoundingClientRect()
  const hoveredEdgeId = hoveredEdge?.id ?? null

  const deleteHoveredEdge = (): void => {
    if (!hoveredEdge || !editor.getShape(hoveredEdge.id)) return
    markUndoPoint(editor, 'delete-connection')
    editor.deleteShapes([hoveredEdge.id])
    clearEdgeSelection()
    setHoveredEdge(null)
    toast('已断开 1 条连线')
  }

  return (
    <>
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
        </defs>
        {edges.map((edge) => {
          if (edge.provenance) {
            // 追溯线只在节点之外可见，且不可交互。
            return (
              <g key={edge.id}>
                <path
                  className="data-edge-visible artifact-provenance-edge"
                  d={edge.path}
                  mask={`url(#${overlapMaskId})`}
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
              <path className="data-edge-hit" d={edge.path} data-edge-id={edge.id} />
            </g>
          )
        })}
      </svg>
      {hoveredEdge && !hoveredEdge.id.startsWith('artifact:') && (
        <button
          className="data-edge-scissors"
          type="button"
          aria-label="删除此连线"
          title="删除此连线"
          style={{ left: hoveredEdge.clientX, top: hoveredEdge.clientY }}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            deleteHoveredEdge()
          }}
        >
          <span aria-hidden="true">✂</span>
        </button>
      )}
    </>
  )
}
