import { useState } from 'react'
import { useEditor } from 'tldraw'
import type { NodeBodyProps } from '../registry'
import { ReviewDecisionSchema } from '@shared/agent-flow/node-contracts'
import { NodeIdentity, NodePrimaryButton } from '../../canvas/NodePresentation'
import { useAppStore } from '../../stores/app'
import { ensureCanvasSaved } from '../../canvas/flow-asset-actions'
import { runNodeManually } from '../../engine/executor'

export function ReviewTaskControls({ shape }: Pick<NodeBodyProps, 'shape'>): React.JSX.Element {
  const editor = useEditor(),
    projectId = useAppStore((s) => s.currentProject?.id)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const decision = (() => {
    try {
      return ReviewDecisionSchema.parse(JSON.parse(String(shape.meta?.nodeResult ?? '')))
    } catch {
      return null
    }
  })()
  const run = async (): Promise<void> => {
    if (!projectId || busy) return
    setBusy(true)
    setError('')
    try {
      await ensureCanvasSaved()
      const result = await runNodeManually(editor, projectId, [], shape.id)
      await ensureCanvasSaved()
      if (result.status === 'failed') setError(result.reason ?? '审核失败')
    } catch {
      setError('审核未确认，请核对原运行和保存状态')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <NodeIdentity>
        {decision && (
          <>
            <p className="agent-flow-summary">
              审核：{decision.passed ? '是' : '否'} · 第 {decision.reviewRevision + 1} 轮
            </p>
            <pre className="agent-flow-output">{decision.feedback}</pre>
            {!decision.passed && (
              <p className="agent-flow-pending">
                请在负责修订的节点按反馈提交新版本，再明确运行复审。
              </p>
            )}
          </>
        )}
        <p className="agent-flow-pending">
          完整文本 / JSON 审核；当前先由人明确提交新版本。自动 Agent 返工尚未启用。
        </p>
        {error && (
          <p role="alert" className="agent-flow-pending">
            {error}
          </p>
        )}
      </NodeIdentity>
      <NodePrimaryButton disabled={busy || !projectId} onClick={() => void run()}>
        {busy ? '审核中' : decision ? '提交版本复审' : '审核当前版本'}
      </NodePrimaryButton>
    </>
  )
}
