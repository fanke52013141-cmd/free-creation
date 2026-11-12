import { useEffect, useId, useState, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { canvasFlowDeclarations } from './agent-flow-declarations'
import { resolveFlowDeclaration, CONTROL_LABELS } from '@shared/agent-flow/declarations'
import { NODE_ACCENTS } from '../nodes/registry'
import { useNodePanelStore } from '../stores/nodePanel'
import { useEdgeSelectionStore } from '../stores/edgeSelection'
import './agent-flow-relations.css'
import { NODE_UI } from './node-ui-tokens'
import { buildControlRelationGeometry } from './agent-flow-relation-geometry'

/** Read-only control view. Config is the only persisted truth, not another shape/edge graph. */
export function AgentFlowRelationLayer({
  editor,
  hostRef
}: {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element | null {
  const [, setRevision] = useState(0)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const maskId = `flow-relations-${useId().replace(/:/g, '')}`
  useEffect(() => {
    let frame = 0
    let previousCamera = ''
    const update = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setRevision((value) => value + 1)
      })
    }
    const cameraTick = (): void => {
      const camera = editor.getCamera()
      const signature = `${camera.x}/${camera.y}/${camera.z}`
      if (signature !== previousCamera) {
        previousCamera = signature
        update()
      }
    }
    const document = editor.store.listen(update, { scope: 'document' })
    const session = editor.store.listen(update, { scope: 'session' })
    editor.on('tick', cameraTick)
    editor.on('resize', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      document()
      session()
      editor.off('tick', cameraTick)
      editor.off('resize', update)
      window.removeEventListener('resize', update)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor])
  useEffect(() => {
    setHost(hostRef.current)
  }, [hostRef])
  if (!host) return null
  if (
    !editor
      .getCurrentPageShapes()
      .some(
        (shape) =>
          shape.type === 'node-card' &&
          ['agent', 'state-machine', 'ai-review'].includes(
            (shape as import('./NodeCardShape').NodeCardShape).props.nodeType
          )
      )
  )
    return null
  const graph = canvasFlowDeclarations(editor)
  const relations = graph.nodes.flatMap(
    (node) => resolveFlowDeclaration(node, graph.nodes, graph.edges).relations
  )
  const offset = host.getBoundingClientRect()
  const rects = graph.shapes.flatMap((shape) => {
    if (editor.isShapeHidden(shape.id as TLShapeId)) return []
    const bounds = editor.getShapePageBounds(shape.id as TLShapeId)
    if (!bounds) return []
    const start = editor.pageToScreen({ x: bounds.x, y: bounds.y })
    const end = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
    const header = NODE_UI.header.height * editor.getCamera().z
    return [
      {
        id: shape.id,
        x: start.x - offset.left,
        y: start.y - offset.top - header,
        w: end.x - start.x,
        h: end.y - start.y + header
      }
    ]
  })
  const byId = new Map<string, (typeof rects)[number]>(rects.map((rect) => [rect.id, rect]))
  const lines = relations.flatMap((relation) => {
    const source = byId.get(relation.sourceNodeId)
    const target = byId.get(relation.targetNodeId)
    if (!source || !target) return []
    // 视图只依赖屏幕矩形：关系语义、授权范围和配置都不参与几何计算。
    // L3：返工线偏好下弧，避免与正向控制线挤在同一侧。
    return [
      {
        ...relation,
        ...buildControlRelationGeometry(source, target, rects, undefined, {
          preferBottom: relation.kind === 'rework'
        })
      }
    ]
  })
  if (!lines.length) return null
  // L3 聚焦：选中节点时，两端都不在选区内的关系淡化（只读视图态，不落盘）。
  const selectedIds = new Set(editor.getSelectedShapes().map((shape) => shape.id as string))
  const focusActive = selectedIds.size > 0
  const isDimmed = (line: (typeof lines)[number]): boolean =>
    focusActive && !selectedIds.has(line.sourceNodeId) && !selectedIds.has(line.targetNodeId)
  const openOwner = (id: string): void => {
    useEdgeSelectionStore.getState().clear()
    editor.select(id as TLShapeId)
    useNodePanelStore.getState().open('contract', id as TLShapeId, 'settings')
  }
  const CONTROL_KINDS = ['controls', 'observes', 'review-gate', 'rework'] as const
  return (
    <svg className="agent-flow-relation-layer" aria-label="控制关系（虚线，不是数据连线）">
      <defs>
        {CONTROL_KINDS.map((kind) => (
          <marker
            key={kind}
            id={`${maskId}-arrow-${kind}`}
            viewBox="0 0 8 8"
            refX={7}
            refY={4}
            markerWidth={7}
            markerHeight={7}
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8" fill="none" className={`flow-arrow-${kind}`} />
          </marker>
        ))}
        <mask id={maskId}>
          <rect width="100%" height="100%" fill="white" />
          {rects.map((rect) => (
            <rect key={rect.id} x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill="black" />
          ))}
        </mask>
      </defs>
      <g mask={`url(#${maskId})`}>
        {lines.map((line) => (
          <path
            key={line.id}
            data-control-kind={line.kind}
            data-control-owner={line.ownerNodeId}
            data-control-target={line.targetNodeId}
            data-control-source={line.sourceNodeId}
            data-anchor-source={line.source.side}
            data-anchor-target={line.target.side}
            data-arrow-x={line.target.x}
            data-arrow-y={line.target.y}
            d={line.path}
            markerEnd={`url(#${maskId}-arrow-${line.kind})`}
            stroke={NODE_ACCENTS['state-machine']}
            className={`agent-flow-control-path${isDimmed(line) ? ' is-dimmed' : ''}`}
          />
        ))}
      </g>
      {lines.map((line) => (
        <g
          key={line.id}
          role="button"
          tabIndex={0}
          aria-label={`配置控制关系：${CONTROL_LABELS[line.kind]}`}
          className={`agent-flow-control-label${isDimmed(line) ? ' is-dimmed' : ''}`}
          transform={`translate(${line.labelX},${line.labelY})`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => openOwner(line.ownerNodeId)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              openOwner(line.ownerNodeId)
            }
          }}
        >
          <rect x={-36} y={-11} width={72} height={22} rx={5} />
          <text textAnchor="middle" dominantBaseline="middle">
            {CONTROL_LABELS[line.kind]}
          </text>
          <title>声明关系，执行尚未接入；点击打开所属节点设置</title>
        </g>
      ))}
    </svg>
  )
}
