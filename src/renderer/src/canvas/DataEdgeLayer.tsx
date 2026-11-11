// 节点数据连线覆盖层（页面坐标 + 镜像 tldraw 相机变换）。
//
// 此前的实现是"屏幕坐标 SVG"：每当相机变化（编辑器 tick / resize），就用 requestAnimationFrame
// 触发一次 React 全量重渲染，把每条连线的 path 的 d、strokeWidth、drop-shadow 半径、mask 都
// 按新 zoom 重写一遍，再用页面坐标换算端点。快速 Ctrl+滚轮缩放时这等于每帧重算整层：
//   - 连线几何与节点卡片各自在不同的帧提交，端点会短暂脱离端口（视觉上"线闪一下/消失再出现"）；
//   - drop-shadow 半径随 zoom 每帧变化，而 .data-edge-visible 的 transition 又包含 filter，
//     等于每帧重新启动一次滤镜过渡，整层滤镜持续重算；
//   - 大面积 mask + 每帧失效的 SVG 内容，让缩放路径上的光栅化远超一帧预算。
//
// 现在几何只依赖页面坐标，缩放/平移交给与 tldraw 完全一致的 CSS transform 镜像：
// 路径、滤镜、mask 只在文档变化时重算，相机变化只写一个 transform 字符串（在绘制前由
// MutationObserver 同步），连线因此与节点卡片在同一合成层节奏上移动，不再闪烁。
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { getNodePorts, getNodeType, PORT_COLORS } from '../nodes/registry'
import type { NodeCardShape } from './NodeCardShape'
import { useEdgeSelectionStore } from '../stores/edgeSelection'
import { buildDataEdgePath, NODE_PORT_OUTSET } from './edge-geometry'
import { useConnectionStore, type ConnectionFrom } from '../stores/connection'
import { dynamicPortIdsForShape, portPairCompatible } from './graph'
import { collectNodePortConnections, createNodePortLayout } from './node-port-layout'
import { edgeMaskExtents, type EdgePageRect } from './edge-visual-extents'
import { markUndoPoint } from './history'
import { toast } from '../stores/toast'

interface PageEdge {
  id: TLShapeId
  path: string
  color: string
  /** 视觉流向始终由真实数据源指向真实消费者（或由操作节点指向其产物）。 */
  sourceId: TLShapeId
  targetId: TLShapeId
  provenance?: boolean
  /**
   * 端口已不存在（backend 切换、参数删除等）的存量边。必须继续画出警示样式：
   * 此前直接跳过会让它在画布上不可见、不可选中，运行期才报「连线指向不存在的
   * 输入端口」。仅可视化与可删除，不做自动清理。
   */
  invalid?: boolean
}

type PageRect = EdgePageRect

/**
 * 节点页面边界（不是屏幕边界）。
 *
 * 数据线会被这些矩形挖空。节点始终是画布最上层的实体，连线不能穿透其内容区。
 */
function collectNodeRects(editor: Editor): PageRect[] {
  return editor.getCurrentPageShapes().flatMap((shape) => {
    if (shape.type !== 'node-card') return []
    const bounds = editor.getShapePageBounds(shape.id)
    if (!bounds) return []
    return [{ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }]
  })
}

function collectEdges(editor: Editor, draftFrom: ConnectionFrom | null): PageEdge[] {
  const result: PageEdge[] = []
  const connections = collectNodePortConnections(editor)
  const layouts = new Map<string, Map<string, number>>()
  const getOffsets = (
    shape: NodeCardShape,
    direction: 'in' | 'out',
    ports: ReturnType<typeof getNodePorts>['in']
  ): Map<string, number> => {
    const key = `${shape.id}:${direction}`
    const cached = layouts.get(key)
    if (cached) return cached
    const candidates = new Set(
      !draftFrom || draftFrom.shapeId === shape.id
        ? []
        : direction === 'in' && draftFrom.direction !== 'in'
          ? ports
              .filter((port) =>
                portPairCompatible({ type: draftFrom.portType, schema: draftFrom.schema }, port)
              )
              .map((port) => port.id)
          : direction === 'out' && draftFrom.direction === 'in'
            ? ports
                .filter((port) =>
                  portPairCompatible(port, {
                    type: draftFrom.portType,
                    schema: draftFrom.schema
                  })
                )
                .map((port) => port.id)
            : []
    )
    const visible = createNodePortLayout(
      ports,
      connections.get(shape.id)?.[direction] ?? new Set<string>(),
      shape.props.h,
      candidates,
      dynamicPortIdsForShape(shape)[direction]
    ).offsets
    layouts.set(key, visible)
    return visible
  }

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
    // 端口有效性判定与 deriveGraph / collectContractInputs 同源：都经 getNodeType +
    // getNodePorts 动态解析，不在本层另立一套判定。
    const fromIndex = sourcePorts.out.findIndex((port) => port.id === arrow.meta.fromPort)
    const toIndex = targetPorts.in.findIndex((port) => port.id === arrow.meta.toPort)
    const portMissing = fromIndex < 0 || toIndex < 0
    const fromY = portMissing
      ? undefined
      : getOffsets(source, 'out', sourcePorts.out).get(arrow.meta.fromPort)
    const toY = portMissing
      ? undefined
      : getOffsets(target, 'in', targetPorts.in).get(arrow.meta.toPort)
    if (!portMissing && (fromY === undefined || toY === undefined)) continue
    // 分组后 shape.x/y 是相对父 group 的局部坐标，直接相加会让连线“飘走”。
    // getShapePageBounds 返回页面绝对边界（含父级 group 的平移），端口纵向偏移
    // 再按高度比例映射到页面 bounds，保证任何嵌套层级下锚点都贴住节点边缘。
    const sourceBounds = editor.getShapePageBounds(source.id)
    const targetBounds = editor.getShapePageBounds(target.id)
    if (!sourceBounds || !targetBounds) continue
    // 失效边没有可用端口锚点，退化为两端节点的竖直中线，仍按节点边缘收口。
    const sourceAnchorY =
      fromY === undefined
        ? sourceBounds.y + sourceBounds.height / 2
        : source.props.h > 0
          ? sourceBounds.y + (sourceBounds.height * fromY) / source.props.h
          : sourceBounds.y
    const targetAnchorY =
      toY === undefined
        ? targetBounds.y + targetBounds.height / 2
        : target.props.h > 0
          ? targetBounds.y + (targetBounds.height * toY) / target.props.h
          : targetBounds.y
    // 端口圆心位于卡片外侧，正式数据线也以圆心为锚点，不能留一段“线没接上”的空隙。
    // 这里的坐标全部是页面坐标：屏幕位置由镜像的相机 transform 一次性给出。
    const fromPort = sourcePorts.out[fromIndex]
    result.push({
      id: arrow.id,
      // A connection inherits the source node accent, matching its output port.
      color:
        getNodeType(source.props.nodeType)?.color ??
        PORT_COLORS[fromPort?.type ?? 'any'] ??
        '#8f73ff',
      sourceId: source.id,
      targetId: target.id,
      invalid: portMissing,
      path: buildDataEdgePath(
        { x: sourceBounds.maxX + NODE_PORT_OUTSET, y: sourceAnchorY },
        { x: targetBounds.x - NODE_PORT_OUTSET, y: targetAnchorY }
      )
    })
  }
  // 运行产物与操作节点的关系只作可视化追溯，绝不能被当成可执行数据边。
  for (const asset of editor.getCurrentPageShapes()) {
    if (asset.type !== 'node-card') continue
    const producerId = (asset.meta as Record<string, unknown> | undefined)?.artifactProducerId
    if (typeof producerId !== 'string' || asset.meta.artifactLinkHidden === true) continue
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
    const producerOutOffsets = getOffsets(producer, 'out', producerPorts.out)
    const fromY = outIdx >= 0 ? producerOutOffsets.get(producerPorts.out[outIdx].id) : undefined
    const sourceAnchorY =
      fromY !== undefined && producer.props.h > 0
        ? producerBounds.y + (producerBounds.height * fromY) / producer.props.h
        : producerBounds.y + producerBounds.height / 2

    const assetPorts = getNodePortsForShape(asset as NodeCardShape)
    const inIdx = assetPorts.in.length > 0 ? 0 : -1
    const toY =
      inIdx >= 0
        ? getOffsets(asset as NodeCardShape, 'in', assetPorts.in).get(assetPorts.in[inIdx].id)
        : undefined
    const targetAnchorY =
      toY !== undefined && (asset as NodeCardShape).props.h > 0
        ? assetBounds.y + (assetBounds.height * toY) / (asset as NodeCardShape).props.h
        : assetBounds.y + assetBounds.height / 2

    const outPort = outIdx >= 0 ? producerPorts.out[outIdx] : undefined
    // 追溯线同样从生产节点出发，颜色必须跟随该节点的输出色。
    const assetOutType = assetPorts.out[0]?.type
    result.push({
      id: `artifact:${asset.id}` as TLShapeId,
      color:
        getNodeType(producer.props.nodeType)?.color ??
        (assetOutType
          ? (PORT_COLORS[assetOutType] ?? '#94a3b8')
          : outPort
            ? (PORT_COLORS[outPort.type] ?? '#94a3b8')
            : '#94a3b8'),
      sourceId: producer.id,
      targetId: asset.id,
      provenance: true,
      path: buildDataEdgePath(
        { x: producerBounds.maxX + NODE_PORT_OUTSET, y: sourceAnchorY },
        { x: assetBounds.x - NODE_PORT_OUTSET, y: targetAnchorY }
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
 * 把 tldraw 的相机变换镜像到连线层。
 *
 * tldraw 4.x 把 `scale(z) translate(x, y)` 写在 `.tl-html-layer.tl-shapes` 的 inline style 上；
 * 连线层使用同样的 1×1 盒模型与默认 transform-origin，直接复制该字符串即可与节点逐像素同步，
 * 不依赖 tldraw 内部坐标常量的推算。MutationObserver 在浏览器绘制前回调，因此同一帧内对齐。
 */
function mirrorCameraTransform(editor: Editor, frame: HTMLElement): () => void {
  const container = editor.getContainer()
  let layer: HTMLElement | null = null
  let attached = false
  let retryTimer: number | undefined
  const observer = new MutationObserver(() => sync())

  const sync = (): void => {
    if (!layer || !layer.isConnected) {
      const next = container.querySelector<HTMLElement>('.tl-shapes')
      if (!next) return
      if (next !== layer) {
        // tldraw 重挂载时层节点可能被替换；始终把观察器挂到当前节点上。
        observer.disconnect()
        observer.observe(next, { attributes: true, attributeFilter: ['style'] })
        layer = next
        attached = true
      }
    }
    const transform = layer.style.transform
    if (transform && frame.style.transform !== transform) frame.style.transform = transform
    // 命中层需要保持屏幕空间恒定的 14px 容差，页面坐标下折算成 14/zoom（见 CSS）。
    const zoom = editor.getCamera().z || 1
    const hitWidth = `${14 / zoom}px`
    if (frame.style.getPropertyValue('--edge-hit-width') !== hitWidth) {
      frame.style.setProperty('--edge-hit-width', hitWidth)
    }
  }

  sync()
  if (!attached) {
    // 编辑器挂载通常早于本层；极少数情况下重试几次，避免永久丢失同步。
    let retries = 0
    retryTimer = window.setInterval(() => {
      sync()
      retries += 1
      if (attached || retries > 40) {
        window.clearInterval(retryTimer)
        retryTimer = undefined
      }
    }, 50)
  }
  return () => {
    observer.disconnect()
    if (retryTimer !== undefined) window.clearInterval(retryTimer)
  }
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
  interactive = true
}: {
  editor: Editor
  interactive?: boolean
}): React.JSX.Element {
  const [, setRevision] = useState(0)
  const selectedEdgeId = useEdgeSelectionStore((state) => state.selectedEdgeId)
  // `from` is stable while the pointer moves, so edge anchors reflow once when a
  // connection gesture starts or ends instead of recalculating on every mouse frame.
  const draftFrom = useConnectionStore((state) => state.draft?.from ?? null)
  const select = useEdgeSelectionStore((state) => state.select)
  const clearEdgeSelection = useEdgeSelectionStore((state) => state.clear)
  const [hoveredEdge, setHoveredEdge] = useState<{
    id: TLShapeId
    clientX: number
    clientY: number
  } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const reactId = useId().replace(/:/g, '')
  const overlapMaskId = `data-edge-node-mask-${reactId}`

  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    return mirrorCameraTransform(editor, frame)
  }, [editor])

  useEffect(() => {
    let frame = 0
    const update = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setRevision((value) => value + 1)
      })
    }
    // 相机变化不再重算几何；只有文档变化（位置、端口、节点尺寸、连线本身）才需要重新收集。
    // 不再监听 session：tldraw 把相机放在实例状态里，session 会在每个缩放帧触发一次全量重渲染。
    const offDocument = editor.store.listen(update, { scope: 'document' })
    return () => {
      offDocument()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor])

  const edges = collectEdges(editor, draftFrom).filter(
    (edge) => !editor.isShapeHidden(edge.sourceId) && !editor.isShapeHidden(edge.targetId)
  )
  const nodeRects = collectNodeRects(editor)
  const nodeRectsRef = useRef<PageRect[]>([])
  useEffect(() => {
    nodeRectsRef.current = nodeRects
  })
  const mask = edgeMaskExtents(nodeRects)
  const hoveredEdgeId = hoveredEdge?.id ?? null
  const hoveredEdgeIsArtifact = hoveredEdge !== null && hoveredEdge.id.startsWith('artifact:')

  /** 判断屏幕坐标是否落在任一连线的可点击描边区域内。 */
  const hitTest = (clientX: number, clientY: number): TLShapeId | null => {
    const svg = svgRef.current
    if (!svg) return null
    const matrix = svg.getScreenCTM()
    if (!matrix) return null
    // 指针换算到连线层的 user space（= 页面坐标），与 path 的 d 同一坐标系。
    const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse())
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
      if (path.isPointInStroke(point)) {
        const edgeId = path.dataset.edgeId
        if (!edgeId) return null
        return edgeId as TLShapeId
      }
    }
    return null
  }

  // window 捕获阶段处理连线交互：先于 tldraw 与 React 合成事件，能精确决定
  // “这次按下属于连线选中”还是“完全放行给画布框选”。
  useEffect(() => {
    if (!interactive) return
    const canvasCovered = (): boolean =>
      Boolean(document.querySelector('.composite-canvas-overlay'))
    const onPointerDown = (event: PointerEvent): void => {
      if (canvasCovered()) return
      // 剪刀是唯一会删除连线的显式操作，不能被窗口捕获阶段的连线选中逻辑截获。
      if (event.target instanceof Element && event.target.closest('.data-edge-scissors')) return
      // 预览弹层通过 portal 挂到 body；弹层上方即使覆盖着一条画布连线，也不能
      // 被连线的 window 捕获监听抢走 pointerdown，否则关闭按钮会收不到 click。
      if (event.target instanceof Element && event.target.closest('.media-preview-mask')) return
      if (event.target instanceof Element && event.target.closest('.agent-flow-control-label'))
        return
      // 端口与节点卡片在连接层之上（呈现规范 §8）。连线的 14px 命中描边端点
      // 恰好覆盖端口圆心，若不在这里放行，输出端口一旦接过一条连线就永远
      // 无法再从该端口拖出新连线，所有"一输出扇出多输入"的流程都会被阻断。
      if (event.target instanceof Element && event.target.closest('.node-card-wrap')) return
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit || hit.startsWith('artifact:')) return
      // 命中连线：选中并终止传播，画布不会开始框选/平移，已选连线也不会被清除。
      event.preventDefault()
      event.stopPropagation()
      // 一条数据线被选中时，必须解除之前的节点选区。否则 Delete 会按节点批量删除
      // 的分支执行，把上游节点和其余关联线一并删掉。
      editor.setSelectedShapes([])
      select(hit)
    }
    const onContextMenu = (event: MouseEvent): void => {
      if (canvasCovered()) return
      if (event.target instanceof Element && event.target.closest('.agent-flow-control-label'))
        return
      if (event.target instanceof Element && event.target.closest('.media-preview-mask')) return
      // 与 pointerdown 同理：落在节点/端口上的右键属于节点，交给节点侧处理。
      if (event.target instanceof Element && event.target.closest('.node-card-wrap')) return
      const hit = hitTest(event.clientX, event.clientY)
      if (!hit || hit.startsWith('artifact:')) return
      // 右键落在连线上：选中该连线，且不让空白处的创建菜单弹出。
      event.preventDefault()
      event.stopPropagation()
      editor.setSelectedShapes([])
      select(hit)
    }
    let moveFrame = 0
    const onPointerMove = (event: PointerEvent): void => {
      if (
        canvasCovered() ||
        (event.target instanceof Element && event.target.closest('.agent-flow-control-label'))
      ) {
        if (moveFrame) cancelAnimationFrame(moveFrame)
        moveFrame = 0
        setHoveredEdge(null)
        return
      }
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
  }, [editor, interactive, select])

  const deleteHoveredEdge = (): void => {
    if (!hoveredEdge) return
    // 追溯线（artifact:）不是可删除的数据边，剪刀只把产物节点标记为“已隐藏追溯线”；
    // 普通数据边仍走真实删除。两者文案必须区分，不能把隐藏说成断线。
    const isArtifactLink = hoveredEdge.id.startsWith('artifact:')
    if (isArtifactLink) {
      const edge = edges.find((item) => item.id === hoveredEdge.id && item.provenance)
      const asset = edge && editor.getShape<NodeCardShape>(edge.targetId)
      if (!asset || asset.type !== 'node-card') return
      markUndoPoint(editor, 'hide-artifact-link')
      editor.updateShape({ id: asset.id, type: 'node-card', meta: { artifactLinkHidden: true } })
    } else {
      if (!editor.getShape(hoveredEdge.id)) return
      markUndoPoint(editor, 'delete-connection')
      editor.deleteShapes([hoveredEdge.id])
    }
    clearEdgeSelection()
    setHoveredEdge(null)
    toast(isArtifactLink ? '已隐藏追溯线' : '已断开 1 条连线')
  }

  return (
    <>
      <div className="data-edge-clip">
        <div className="data-edge-frame" ref={frameRef}>
          <svg
            className="data-edge-layer"
            ref={svgRef}
            aria-label="节点数据连线"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <mask
                id={overlapMaskId}
                maskUnits="userSpaceOnUse"
                x={mask.x}
                y={mask.y}
                width={mask.width}
                height={mask.height}
              >
                <rect x={mask.x} y={mask.y} width={mask.width} height={mask.height} fill="white" />
                {nodeRects.map((rect, index) => (
                  <rect key={index} {...rect} fill="black" />
                ))}
              </mask>
            </defs>
            {edges.length > 0 && (
              <g mask={`url(#${overlapMaskId})`}>
                {edges.map((edge) => {
                  if (edge.provenance) {
                    // 追溯线只在节点之外可见，但沿用普通连线的颜色和流动层级。
                    return (
                      <g key={edge.id} data-edge-id={edge.id}>
                        <path
                          className="data-edge-glow artifact-provenance-glow"
                          d={edge.path}
                          vectorEffect="non-scaling-stroke"
                          style={{ stroke: edge.color, color: edge.color }}
                        />
                        <path
                          className="data-edge-visible artifact-provenance-edge"
                          d={edge.path}
                          vectorEffect="non-scaling-stroke"
                          style={{ stroke: edge.color, color: edge.color }}
                        />
                        <path
                          className="data-edge-flow artifact-provenance-flow"
                          d={edge.path}
                          pathLength="1000"
                          vectorEffect="non-scaling-stroke"
                          style={{ color: edge.color }}
                        />
                      </g>
                    )
                  }
                  const active = edge.id === selectedEdgeId
                  const hovered = edge.id === hoveredEdgeId
                  if (edge.invalid) {
                    // 失效边：红色虚线并降透明度，不画流光；命中路径照常注册，
                    // 用户仍可选中 / 悬浮出剪刀手动删除（不做自动清理）。
                    return (
                      <g
                        className={`data-edge is-invalid${active ? ' is-selected' : ''}${
                          hovered ? ' is-hovered' : ''
                        }`}
                        key={edge.id}
                        data-edge-id={edge.id}
                      >
                        <path
                          className="data-edge-visible"
                          d={edge.path}
                          vectorEffect="non-scaling-stroke"
                          style={{ strokeDasharray: '10 7' }}
                        />
                      </g>
                    )
                  }
                  return (
                    <g
                      className={`data-edge${active ? ' is-selected' : ''}${
                        hovered ? ' is-hovered' : ''
                      }`}
                      key={edge.id}
                      data-edge-id={edge.id}
                    >
                      <path
                        className="data-edge-glow"
                        d={edge.path}
                        vectorEffect="non-scaling-stroke"
                        style={{ stroke: edge.color, color: edge.color }}
                      />
                      <path
                        className="data-edge-visible"
                        d={edge.path}
                        vectorEffect="non-scaling-stroke"
                        style={{ stroke: edge.color, color: edge.color }}
                      />
                      <path
                        className="data-edge-flow"
                        d={edge.path}
                        pathLength="1000"
                        vectorEffect="non-scaling-stroke"
                        style={{ color: edge.color }}
                      />
                    </g>
                  )
                })}
              </g>
            )}
            {interactive &&
              edges.map((edge) => (
                <path
                  className="data-edge-hit"
                  key={`hit-${edge.id}`}
                  d={edge.path}
                  data-edge-id={edge.id}
                />
              ))}
          </svg>
        </div>
      </div>
      {interactive && hoveredEdge && (
        <button
          className="data-edge-scissors"
          type="button"
          aria-label={hoveredEdgeIsArtifact ? '隐藏追溯线' : '删除此连线'}
          title={hoveredEdgeIsArtifact ? '隐藏追溯线' : '删除此连线'}
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
