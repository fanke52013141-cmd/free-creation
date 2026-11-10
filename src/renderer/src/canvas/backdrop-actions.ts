import type { Editor, TLShapeId } from 'tldraw'
import type { GraphPatchOp } from '@shared/agent-access/graph-ops'
import { toast } from '../stores/toast'
import { planGraphPatch } from './graph-patch'

export function applyBackdropAction(
  editor: Editor,
  op: Extract<GraphPatchOp, { action: `backdrop.${string}` }>
): void {
  const result = planGraphPatch(editor, [op], [])
  if (!result.ok) {
    toast('无法更新背景板')
    return
  }
  editor.markHistoryStoppingPoint(op.action)
  editor.run(() => result.plan.apply(editor))
  editor.markHistoryStoppingPoint('backdrop-complete')
  if (op.action === 'backdrop.create') editor.select(op.backdropId as TLShapeId)
}
