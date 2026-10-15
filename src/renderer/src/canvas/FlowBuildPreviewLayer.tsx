import { useEffect, useId, useState, useSyncExternalStore, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import type { BuildPreview } from '@shared/agent-flow/builder'
import { getNodeType } from '../nodes/registry'
import {
  getFlowBuildPreviewRevision,
  getFlowBuildPreviews,
  subscribeFlowBuildPreviews
} from './flow-build-preview-store'
import './flow-build-preview.css'

type Rect = { x: number; y: number; w: number; h: number }

function edgePath(from: Rect, to: Rect): string {
  const fromCenter = from.x + from.w / 2,
    toCenter = to.x + to.w / 2,
    forward = toCenter >= fromCenter,
    startX = forward ? from.x + from.w : from.x,
    endX = forward ? to.x : to.x + to.w,
    startY = from.y + from.h / 2,
    endY = to.y + to.h / 2,
    bend = Math.max(42, Math.abs(endX - startX) / 2),
    controlA = startX + (forward ? bend : -bend),
    controlB = endX - (forward ? bend : -bend)
  return `M ${startX} ${startY} C ${controlA} ${startY}, ${controlB} ${endY}, ${endX} ${endY}`
}

function previewRelations(preview: BuildPreview): Array<{
  id: string
  from: string
  to: string
  kind: 'data' | 'control' | 'observe' | 'gate' | 'rework'
}> {
  const data = preview.edges.map((edge, index) => ({
    id: `data-${index}`,
    from: edge.from.nodeId,
    to: edge.to.nodeId,
    kind: 'data' as const
  }))
  const control = preview.nodes.flatMap((node) => {
    if (!['agent', 'ai-review'].includes(node.type)) return []
    try {
      const config = JSON.parse(node.config) as {
        relations?: Array<{ sourceNodeId?: unknown; targetNodeId?: unknown; kind?: unknown }>
      }
      return (config.relations ?? []).flatMap((relation, index) =>
        ['controls', 'observes', 'review-gate', 'rework'].includes(String(relation.kind)) &&
        typeof relation.sourceNodeId === 'string' &&
        typeof relation.targetNodeId === 'string'
          ? [
              {
                id: `control-${node.id}-${index}`,
                from: relation.sourceNodeId,
                to: relation.targetNodeId,
                kind:
                  relation.kind === 'controls'
                    ? ('control' as const)
                    : relation.kind === 'observes'
                      ? ('observe' as const)
                      : relation.kind === 'review-gate'
                        ? ('gate' as const)
                        : ('rework' as const)
              }
            ]
          : []
      )
    } catch {
      return []
    }
  })
  return [...data, ...control]
}

export function FlowBuildPreviewLayer({
  editor,
  hostRef,
  projectId
}: {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
  projectId: string
}): React.JSX.Element | null {
  const [, setRevision] = useState(0)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const markerId = `flow-build-preview-arrow-${useId().replace(/:/g, '')}`
  useSyncExternalStore(
    subscribeFlowBuildPreviews,
    getFlowBuildPreviewRevision,
    getFlowBuildPreviewRevision
  )
  useEffect(() => {
    setHost(hostRef.current)
  }, [hostRef])
  useEffect(() => {
    let frame = 0
    const update = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setRevision((value) => value + 1)
      })
    }
    const document = editor.store.listen(update, { scope: 'document' })
    const session = editor.store.listen(update, { scope: 'session' })
    editor.on('tick', update)
    editor.on('resize', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      document()
      session()
      editor.off('tick', update)
      editor.off('resize', update)
      window.removeEventListener('resize', update)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor])

  const previews = getFlowBuildPreviews(projectId).filter(
    (preview) => !editor.isShapeHidden(preview.nodeId as TLShapeId)
  )
  if (!host || !previews.length) return null
  const hostBounds = host.getBoundingClientRect(),
    zoom = editor.getCamera().z
  const rectForPlanned = (node: BuildPreview['nodes'][number]): Rect => {
    const topLeft = editor.pageToScreen({ x: node.x, y: node.y })
    return {
      x: topLeft.x - hostBounds.left,
      y: topLeft.y - hostBounds.top,
      w: 340 * zoom,
      h: 260 * zoom
    }
  }
  const rectForExisting = (nodeId: string): Rect | null => {
    const bounds = editor.getShapePageBounds(nodeId as TLShapeId)
    if (!bounds) return null
    const topLeft = editor.pageToScreen({ x: bounds.x, y: bounds.y })
    const bottomRight = editor.pageToScreen({ x: bounds.maxX, y: bounds.maxY })
    return {
      x: topLeft.x - hostBounds.left,
      y: topLeft.y - hostBounds.top,
      w: bottomRight.x - topLeft.x,
      h: bottomRight.y - topLeft.y
    }
  }
  return (
    <div className="flow-build-preview-layer" aria-label="建图空间预览">
      {previews.map((preview) => {
        const previewMarkerId = `${markerId}-${preview.buildId.replace(/[^a-zA-Z0-9_-]/g, '')}`
        const rects = new Map(preview.nodes.map((node) => [node.id, rectForPlanned(node)]))
        const relations = previewRelations(preview).flatMap((relation) => {
          const from = rects.get(relation.from) ?? rectForExisting(relation.from)
          const to = rects.get(relation.to) ?? rectForExisting(relation.to)
          return from && to ? [{ ...relation, path: edgePath(from, to) }] : []
        })
        return (
          <div
            key={`${preview.projectId}:${preview.buildId}`}
            data-preview-data-edges={
              relations.filter((relation) => relation.kind === 'data').length
            }
            data-preview-control-edges={
              relations.filter((relation) => relation.kind === 'control').length
            }
            data-preview-observe-edges={
              relations.filter((relation) => relation.kind === 'observe').length
            }
            data-preview-gate-edges={
              relations.filter((relation) => relation.kind === 'gate').length
            }
            data-preview-rework-edges={
              relations.filter((relation) => relation.kind === 'rework').length
            }
          >
            <svg className="flow-build-preview-edges" aria-hidden="true">
              <defs>
                <marker
                  id={previewMarkerId}
                  viewBox="0 0 8 8"
                  refX={7}
                  refY={4}
                  markerWidth={7}
                  markerHeight={7}
                  orient="auto"
                >
                  <path d="M 0 0 L 8 4 L 0 8 Z" fill="var(--brand)" />
                </marker>
              </defs>
              {relations.map((relation) => (
                <path
                  key={relation.id}
                  d={relation.path}
                  markerEnd={`url(#${previewMarkerId})`}
                  className={`flow-build-preview-edge is-${relation.kind}`}
                />
              ))}
            </svg>
            {preview.nodes.map((node) => {
              const screen = rectForPlanned(node),
                typeLabel = getNodeType(node.type)?.label ?? node.type
              return (
                <div
                  key={node.id}
                  className="flow-build-preview-node"
                  data-preview-node-id={node.id}
                  data-preview-node-type={node.type}
                  aria-label={`拟创建：${node.title}，${typeLabel}`}
                  style={{
                    left: screen.x,
                    top: screen.y,
                    transform: `scale(${zoom})`
                  }}
                >
                  <span className="flow-build-preview-kicker">拟创建 · {typeLabel}</span>
                  <strong>{node.title}</strong>
                  <span>{node.text || typeLabel}</span>
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
