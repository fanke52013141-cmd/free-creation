import type { Editor, TLShape } from 'tldraw'
import { markUndoPoint } from './history'
/** Display-only metadata: execution reads all page shapes regardless of this flag. */
export function artifactShapeHidden(shape: TLShape): boolean {
  return shape.type === 'node-card' && shape.meta.resultGroupCollapsed === true
}

export function showArtifactGroups(editor: Editor, onlyRunId?: string): void {
  markUndoPoint(editor, 'result-group-visibility')
  editor.run(() => {
    for (const shape of editor.getCurrentPageShapes()) {
      if (shape.type !== 'node-card' || typeof shape.meta.runGroupId !== 'string') continue
      editor.updateShape({
        id: shape.id,
        type: shape.type,
        meta: {
          resultGroupCollapsed: onlyRunId ? shape.meta.runGroupId !== onlyRunId : false
        }
      })
    }
  })
}

export function artifactShapeVisibility(shape: TLShape): 'hidden' | 'inherit' {
  return artifactShapeHidden(shape) ? 'hidden' : 'inherit'
}
