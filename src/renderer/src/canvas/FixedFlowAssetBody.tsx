import { useEditor } from 'tldraw'
import { readFlowAssetSnapshot } from './flow-asset-snapshot'
import type { NodeCardShape } from './NodeCardShape'
import { NodePrimaryButton } from './NodePresentation'
import { createEditableAssetDraft } from './flow-asset-actions'
import { beginAssetPlacement } from './flow-asset-diagnostics'
import { useAppStore } from '../stores/app'
import { toast } from '../stores/toast'

/** Committed result preview, rather than an editable document input. */
export function FixedFlowAssetBody({ shape }: { shape: NodeCardShape }): React.JSX.Element | null {
  const editor = useEditor()
  const projectId = useAppStore((state) => state.currentProject?.id)
  const value = readFlowAssetSnapshot(shape)
  if (!value) return null
  return (
    <div className="node-text fixed-flow-asset-body">
      <span className="node-text-body">
        {value.kind === 'json' ? JSON.stringify(value.data, null, 2) : value.text}
      </span>
      <NodePrimaryButton
        disabled={!projectId}
        onClick={() => {
          if (!projectId) return
          const finish = beginAssetPlacement(projectId, shape.id, 'draft-apply')
          try {
            createEditableAssetDraft(editor, shape, value)
            finish(true)
          } catch {
            finish(false)
            toast('创建资产草稿失败，请重试')
          }
        }}
      >
        创建可编辑副本
      </NodePrimaryButton>
    </div>
  )
}
