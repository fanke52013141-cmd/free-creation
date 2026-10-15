import { useState } from 'react'
import { useEditor } from 'tldraw'
import type { NodeBodyProps } from '../registry'
import { ReviewDecisionSchema, ReviewNodeConfigSchema } from '@shared/agent-flow/node-contracts'
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
  const sampled = (() => {
    try {
      return (
        ReviewNodeConfigSchema.parse(JSON.parse(shape.props.config)).reviewMode === 'sampled-video'
      )
    } catch {
      return false
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
            {decision.videoEvidence && (
              <p className="agent-flow-pending">
                抽样位置：
                {decision.videoEvidence.frames
                  .map((frame) => `${(frame.timeMs / 1000).toFixed(2)}s`)
                  .join('、')}
              </p>
            )}
            {!decision.passed && (
              <p className="agent-flow-pending">
                请在负责修订的节点按反馈提交新版本，再明确运行复审。
              </p>
            )}
          </>
        )}
        <p className="agent-flow-pending">
          {sampled
            ? '仅审核四张抽样画面，不含声音、完整时序或未展示的画面；可人工替换视频复审，或由已配置的主 Agent 在预算内安排专业 Agent 返工。'
            : '完整文本 / JSON 审核；自动审核与返工须由主 Agent 明确配置控制范围。'}
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
