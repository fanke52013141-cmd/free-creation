import { artifactShapeHidden } from './artifact-grouping'
import { useValue, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import type { RefObject } from 'react'
import { markUndoPoint } from './history'

export function ArtifactGroupLayer({
  editor,
  hostRef
}: {
  editor: Editor
  hostRef: RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const groups = useValue(
    'artifact run groups',
    () => {
      const grouped = new Map<string, TLShape[]>()
      for (const shape of editor.getCurrentPageShapes()) {
        if (shape.type !== 'node-card' || typeof shape.meta.runGroupId !== 'string') continue
        const items = grouped.get(shape.meta.runGroupId) ?? []
        items.push(shape)
        grouped.set(shape.meta.runGroupId, items)
      }
      const host = hostRef.current?.getBoundingClientRect()
      return [...grouped].flatMap(([runId, shapes]) => {
        const bounds = shapes.map((shape) => editor.getShapePageBounds(shape.id)).filter(Boolean)
        if (!host || !bounds.length) return []
        const top = editor.pageToScreen({
          x: Math.min(...bounds.map((b) => b!.x)),
          y: Math.min(...bounds.map((b) => b!.y))
        })
        const bottom = editor.pageToScreen({
          x: Math.max(...bounds.map((b) => b!.maxX)),
          y: Math.max(...bounds.map((b) => b!.maxY))
        })
        return [
          {
            runId,
            ids: shapes.map((shape) => shape.id),
            collapsed: shapes.every(artifactShapeHidden),
            left: top.x - host.left - 12,
            top: top.y - host.top - 70,
            width: bottom.x - top.x + 24,
            height: bottom.y - top.y + 84
          }
        ]
      })
    },
    [editor, hostRef]
  )
  return (
    <div className="artifact-groups">
      {groups.map((group) => (
        <div
          key={group.runId}
          className={`artifact-group${group.collapsed ? ' collapsed' : ''}`}
          style={{
            left: group.left,
            top: group.top,
            width: group.width,
            height: group.collapsed ? 32 : group.height
          }}
        >
          <button
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              markUndoPoint(editor, 'result-group-toggle')
              editor.run(() =>
                group.ids.forEach((id: TLShapeId) =>
                  editor.updateShape({
                    id,
                    type: 'node-card',
                    meta: { resultGroupCollapsed: !group.collapsed }
                  })
                )
              )
              if (!group.collapsed)
                editor.setSelectedShapes(
                  editor.getSelectedShapeIds().filter((id) => !group.ids.includes(id))
                )
            }}
          >
            {group.collapsed ? '展开' : '折叠'} · 本轮 {group.ids.length} 个结果
          </button>
        </div>
      ))}
    </div>
  )
}
