import { useEffect, useId, useState, useSyncExternalStore, type RefObject } from 'react'
import type { Editor, TLShapeId } from 'tldraw'
import { getNodeType } from '../nodes/registry'
import {
  getFlowBuildPreviewRevision,
  getFlowBuildPreviews,
  subscribeFlowBuildPreviews,
  type FlowBuildPreviewLike
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

function previewRelations(preview: FlowBuildPreviewLike): Array<{
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
  useSyncExternalStore(
    subscribeFlowBuildPreviews,
    getFlowBuildPreviewRevision,
    getFlowBuildPreviewRevision
  )
  const previews = getFlowBuildPreviews(projectId).filter(
    (preview) => !editor.isShapeHidden(preview.nodeId as TLShapeId)
  )
  // 无建图预览时不挂载任何 editor/tick 监听，彻底消除 60fps 空转刷新。
  if (!previews.length) return null
  return (
    <FlowBuildPreviewContent editor={editor} hostRef={hostRef} previews={previews} />
  )
}

function FlowBuildPreviewContent({
  editor,
  hostRef,
  previews
}: {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
  previews: FlowBuildPreviewLike[]
}): React.JSX.Element | null {
  const [, setRevision] = useState(0)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const markerId = `flow-build-preview-arrow-${useId().replace(/:/g, '')}`
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
    editor.on('resize', update)
    window.addEventListener('resize', update)
    update()
    return () => {
      document()
      session()
      editor.off('resize', update)
      window.removeEventListener('resize', update)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [editor])

  if (!host) return null
  const hostBounds = host.getBoundingClientRect(),
    zoom = editor.getCamera().z
  const rectForPlanned = (node: FlowBuildPreviewLike['nodes'][number]): Rect => {
    const topLeft = editor.pageToScreen({ x: node.x, y: node.y })
    return {
      x: topLeft.x - hostBounds.left,
      y: topLeft.y - hostBounds.top,
      w: 340 * zoom,
      // 与提交后真实节点尺寸一致（NODE_UI.height.default=300；旧 260 为遗留偏差）。
      h: 300 * zoom
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
        const updatedRects = (preview.updatedNodeIds ?? []).flatMap((nodeId) => {
          const rect = rectForExisting(nodeId)
          return rect ? [{ nodeId, rect }] : []
        })
        const deletedRects = (preview.deletedNodeIds ?? []).flatMap((nodeId) => {
          const rect = rectForExisting(nodeId)
          return rect ? [{ nodeId, rect }] : []
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
            data-preview-updated-nodes={updatedRects.length}
            data-preview-deleted-nodes={deletedRects.length}
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
            {updatedRects.map(({ nodeId, rect }) => (
              <div
                key={`upd-${nodeId}`}
                className="flow-build-preview-diff is-update"
                data-preview-diff-node={nodeId}
                aria-label="拟修改节点"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
              >
                <span className="flow-build-preview-diff-badge is-update">拟修改</span>
              </div>
            ))}
            {deletedRects.map(({ nodeId, rect }) => (
              <div
                key={`del-${nodeId}`}
                className="flow-build-preview-diff is-delete"
                data-preview-diff-node={nodeId}
                aria-label="拟删除节点"
                style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
              >
                <span className="flow-build-preview-diff-badge is-delete">拟删除</span>
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
